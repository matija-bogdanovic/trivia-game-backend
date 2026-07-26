import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../app.js";

export const CREDIT_CAP = 5;
export const CREDIT_REFILL_MS = 30 * 60 * 1000; // +1 credit every 30 min
export const LOBBY_CREATE_COST = 1;
export const COINS_PER_WIN = 100;
export const COINS_PER_GAME = 25;

export interface Wallet {
  username: string;
  credits: number;
  lastRefillAt: number;
  coins: number;
  ownedAvatars: string[];
  wins: number;
  gamesPlayed: number;
}

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
  };
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
  const wallet = (res.Item as Wallet | undefined) ?? freshWallet(username);
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

/** fire-and-forget game rewards + lifetime stats */
export async function recordGameResult(
  participants: string[],
  winner: string | null
): Promise<void> {
  await Promise.all(
    participants.map(async (username) => {
      try {
        const wallet = await getWallet(username);
        wallet.gamesPlayed += 1;
        wallet.coins += COINS_PER_GAME;
        if (username === winner) {
          wallet.wins += 1;
          wallet.coins += COINS_PER_WIN;
        }
        await saveWallet(wallet);
      } catch (err) {
        console.error(`Failed to record result for ${username}:`, err);
      }
    })
  );
}
