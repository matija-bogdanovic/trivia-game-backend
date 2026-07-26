import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../app.js";

export const CREDIT_CAP = 5;
export const CREDIT_REFILL_MS = 30 * 60 * 1000; // +1 credit every 30 min
export const LOBBY_CREATE_COST = 1;
export const COINS_PER_WIN = 100;
export const COINS_PER_GAME = 25;
export const POINTS_PER_WIN = 25;
export const POINTS_STREAK_BONUS = 5; // extra per consecutive win
export const POINTS_STREAK_BONUS_CAP = 50;

export interface Wallet {
  username: string;
  credits: number;
  lastRefillAt: number;
  coins: number;
  ownedAvatars: string[];
  wins: number;
  gamesPlayed: number;
  /** leaderboard points, earned per win with a streak bonus */
  points: number;
  currentStreak: number;
  bestStreak: number;
  betsWon: number;
  achievements: string[];
  friends: string[];
  /** incoming friend requests (usernames) */
  friendRequests: string[];
}

/** per-player stats from one finished game, used for achievement checks */
export interface GamePlayerStats {
  username: string;
  wonGame: boolean;
  betsWon: number;
  maxBetWin: number;
  wrongAnswers: number;
}

export interface AchievementDef {
  id: string;
  name: string;
  check: (wallet: Wallet, game: GamePlayerStats) => boolean;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: "first_win", name: "First Blood — win your first game", check: (w) => w.wins >= 1 },
  { id: "streak_10", name: "On Fire — win 10 games in a row", check: (w) => w.currentStreak >= 10 },
  { id: "streak_50", name: "Unstoppable — win 50 games in a row", check: (w) => w.currentStreak >= 50 },
  { id: "streak_100", name: "Legend — win 100 games in a row", check: (w) => w.currentStreak >= 100 },
  { id: "first_bet_win", name: "Gambler — win money on a bet", check: (w) => w.betsWon >= 1 },
  { id: "bet_500", name: "High Roller — win $500+ on a single bet", check: (_w, g) => g.maxBetWin >= 500 },
  { id: "flawless_win", name: "Flawless — win without a single wrong answer", check: (_w, g) => g.wonGame && g.wrongAnswers === 0 },
  { id: "games_50", name: "Veteran — play 50 games", check: (w) => w.gamesPlayed >= 50 },
];

export interface ShopItem {
  id: string;
  name: string;
  cost: number;
  kind: "credits" | "avatar";
  /** for kind=credits: how many credits; for kind=avatar: the emoji */
  value: string;
}

export const SHOP_ITEMS: ShopItem[] = [
  { id: "credits3", name: "3 lobby credits", cost: 100, kind: "credits", value: "3" },
  { id: "av_dragon", name: "Dragon avatar", cost: 150, kind: "avatar", value: "🐉" },
  { id: "av_crown", name: "Crown avatar", cost: 150, kind: "avatar", value: "👑" },
  { id: "av_unicorn", name: "Unicorn avatar", cost: 150, kind: "avatar", value: "🦄" },
  { id: "av_diamond", name: "Diamond avatar", cost: 150, kind: "avatar", value: "💎" },
  { id: "av_alien", name: "Alien avatar", cost: 200, kind: "avatar", value: "👽" },
  { id: "av_fire", name: "Fire avatar", cost: 200, kind: "avatar", value: "🔥" },
];

function freshWallet(username: string): Wallet {
  return {
    username,
    credits: CREDIT_CAP,
    lastRefillAt: Date.now(),
    coins: 0,
    ownedAvatars: [],
    wins: 0,
    gamesPlayed: 0,
    points: 0,
    currentStreak: 0,
    bestStreak: 0,
    betsWon: 0,
    achievements: [],
    friends: [],
    friendRequests: [],
  };
}

/** older wallet rows may predate the streak/achievement fields */
function withDefaults(wallet: Wallet): Wallet {
  wallet.points ??= 0;
  wallet.currentStreak ??= 0;
  wallet.bestStreak ??= 0;
  wallet.betsWon ??= 0;
  wallet.achievements ??= [];
  wallet.friends ??= [];
  wallet.friendRequests ??= [];
  return wallet;
}

/** like getWallet but returns null instead of inventing a row */
export async function getWalletIfExists(
  username: string
): Promise<Wallet | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: "Wallets", Key: { username } })
  );
  if (!res.Item) return null;
  const wallet = withDefaults(res.Item as Wallet);
  refill(wallet);
  return wallet;
}

/** applies time-based credit refill in place */
function refill(wallet: Wallet): Wallet {
  const now = Date.now();
  if (wallet.credits >= CREDIT_CAP) {
    wallet.lastRefillAt = now;
    return wallet;
  }
  const earned = Math.floor((now - wallet.lastRefillAt) / CREDIT_REFILL_MS);
  if (earned > 0) {
    wallet.credits = Math.min(CREDIT_CAP, wallet.credits + earned);
    wallet.lastRefillAt =
      wallet.credits >= CREDIT_CAP
        ? now
        : wallet.lastRefillAt + earned * CREDIT_REFILL_MS;
  }
  return wallet;
}

export function msUntilNextCredit(wallet: Wallet): number | null {
  if (wallet.credits >= CREDIT_CAP) return null;
  return Math.max(0, wallet.lastRefillAt + CREDIT_REFILL_MS - Date.now());
}

export async function getWallet(username: string): Promise<Wallet> {
  const res = await docClient.send(
    new GetCommand({ TableName: "Wallets", Key: { username } })
  );
  const wallet = withDefaults(
    (res.Item as Wallet | undefined) ?? freshWallet(username)
  );
  refill(wallet);
  return wallet;
}

export async function saveWallet(wallet: Wallet): Promise<void> {
  await docClient.send(
    new PutCommand({ TableName: "Wallets", Item: wallet })
  );
}

/** returns the updated wallet, or null if there aren't enough credits */
export async function spendLobbyCredit(
  username: string
): Promise<Wallet | null> {
  const wallet = await getWallet(username);
  if (wallet.credits < LOBBY_CREATE_COST) return null;
  wallet.credits -= LOBBY_CREATE_COST;
  await saveWallet(wallet);
  return wallet;
}

/** returns updated wallet or an error string */
export async function buyItem(
  username: string,
  itemId: string
): Promise<Wallet | string> {
  const item = SHOP_ITEMS.find((i) => i.id === itemId);
  if (!item) return "Unknown item";
  const wallet = await getWallet(username);
  if (item.kind === "avatar" && wallet.ownedAvatars.includes(item.value)) {
    return "Already owned";
  }
  if (wallet.coins < item.cost) return "Not enough coins";
  wallet.coins -= item.cost;
  if (item.kind === "credits") {
    wallet.credits = Math.min(CREDIT_CAP, wallet.credits + Number(item.value));
  } else {
    wallet.ownedAvatars.push(item.value);
  }
  await saveWallet(wallet);
  return wallet;
}

// ---------------------------------------------------------------- friends

/** returns an error string, or 'accepted' when it completed a mutual
 *  request, or 'sent' when a new request was created */
export async function sendFriendRequest(
  from: string,
  to: string
): Promise<string> {
  if (from === to) return "That's you";
  const target = await getWalletIfExists(to);
  if (!target) return "User not found";
  if (target.friends.includes(from)) return "Already friends";

  const me = await getWallet(from);
  // they already asked us — treat this as an accept
  if (me.friendRequests.includes(to)) {
    return acceptFriendRequest(from, to);
  }
  if (target.friendRequests.includes(from)) return "Request already sent";
  target.friendRequests.push(from);
  await saveWallet(target);
  return "sent";
}

export async function acceptFriendRequest(
  username: string,
  from: string
): Promise<string> {
  const me = await getWallet(username);
  if (!me.friendRequests.includes(from)) return "No such request";
  const other = await getWalletIfExists(from);
  if (!other) return "User not found";
  me.friendRequests = me.friendRequests.filter((u) => u !== from);
  if (!me.friends.includes(from)) me.friends.push(from);
  if (!other.friends.includes(username)) other.friends.push(username);
  await Promise.all([saveWallet(me), saveWallet(other)]);
  return "accepted";
}

export async function declineFriendRequest(
  username: string,
  from: string
): Promise<void> {
  const me = await getWallet(username);
  me.friendRequests = me.friendRequests.filter((u) => u !== from);
  await saveWallet(me);
}

export async function removeFriend(
  username: string,
  other: string
): Promise<void> {
  const me = await getWallet(username);
  me.friends = me.friends.filter((u) => u !== other);
  await saveWallet(me);
  const them = await getWalletIfExists(other);
  if (them) {
    them.friends = them.friends.filter((u) => u !== username);
    await saveWallet(them);
  }
}

/**
 * Applies rewards, streaks, points, and achievement unlocks for one finished
 * game. Returns newly unlocked achievements per player so the room can
 * announce them.
 */
export async function recordGameResult(
  stats: GamePlayerStats[]
): Promise<Map<string, AchievementDef[]>> {
  const unlocked = new Map<string, AchievementDef[]>();
  await Promise.all(
    stats.map(async (game) => {
      try {
        const wallet = await getWallet(game.username);
        wallet.gamesPlayed += 1;
        wallet.coins += COINS_PER_GAME;
        wallet.betsWon += game.betsWon;
        if (game.wonGame) {
          wallet.wins += 1;
          wallet.coins += COINS_PER_WIN;
          wallet.currentStreak += 1;
          wallet.bestStreak = Math.max(wallet.bestStreak, wallet.currentStreak);
          wallet.points +=
            POINTS_PER_WIN +
            Math.min(
              POINTS_STREAK_BONUS_CAP,
              POINTS_STREAK_BONUS * (wallet.currentStreak - 1)
            );
        } else {
          wallet.currentStreak = 0;
        }

        const fresh = ACHIEVEMENTS.filter(
          (a) => !wallet.achievements.includes(a.id) && a.check(wallet, game)
        );
        wallet.achievements.push(...fresh.map((a) => a.id));
        if (fresh.length > 0) unlocked.set(game.username, fresh);

        await saveWallet(wallet);
      } catch (err) {
        console.error(`Failed to record result for ${game.username}:`, err);
      }
    })
  );
  return unlocked;
}
