import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getRoomDetails } from "./get_lobby_details.js";
import { getUsernames } from "./get/get_usernames.js";
import createRoom from "./post/room_operations/create_room.js";
import leaveRoom from "./post/room_operations/leave_room.js";
import joinRoom from "./post/room_operations/join_room.js";
import getRoomCode from "./post/room_operations/get_room_code.js";
import getActiveRooms from "./get/get_lobby_count.js";
import {
  getAvatarImageHandler,
  uploadAvatarHandler,
} from "./avatars.js";
import {
  friendActionHandler,
  friendsListHandler,
  lobbiesHandler,
  leaderboardHandler,
  matchDetailHandler,
  myActiveRoomHandler,
  shopBuyHandler,
  walletHandler,
} from "./economy.js";

const router = Router();

/*
 * Anything that reads or writes a specific player's data goes behind
 * requireAuth, which derives the username from a verified Cognito token.
 * The routes left open are genuinely public reads: lobby listings, the
 * leaderboard, and avatar images (shown to other players).
 */

// /signup and /login are gone: Cognito owns auth. They wrote bcrypt users
// into the legacy (always-empty) Players table and issued `token` cookies the
// frontend trusted without verifying the signature.
router.post("/createRoom", requireAuth, createRoom);
router.post("/joinRoom", requireAuth, joinRoom);
router.post("/getRoomCode", requireAuth, getRoomCode);
router.post("/getRoomDetails", getRoomDetails);
router.post("/leaveRoom", requireAuth, leaveRoom);

router.get("/getusernames", getUsernames);
router.get("/getActiveRooms", getActiveRooms);
router.get("/lobbies", lobbiesHandler);
router.get("/leaderboard", leaderboardHandler);
router.post("/wallet", requireAuth, walletHandler);
router.post("/myActiveRoom", requireAuth, myActiveRoomHandler);
router.post("/matches/detail", requireAuth, matchDetailHandler);
router.post("/shop/buy", requireAuth, shopBuyHandler);
router.post("/friends/list", requireAuth, friendsListHandler);
router.post("/friends/action", requireAuth, friendActionHandler);
router.post("/avatar", requireAuth, uploadAvatarHandler);
router.get("/avatar/img/:username", getAvatarImageHandler);

export default router;
