import { Router } from "express";
import { signUp } from "./post/register/signup.js";
import logIn from "./post/register/login.js";
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
  myActiveRoomHandler,
  shopBuyHandler,
  walletHandler,
} from "./economy.js";

const router = Router();

router.post("/signup", signUp);
router.post("/login", logIn);
router.post("/createRoom", createRoom);
router.post("/joinRoom", joinRoom);
router.post("/getRoomCode", getRoomCode);
router.post("/getRoomDetails", getRoomDetails);
router.post("/leaveRoom", leaveRoom);

router.get("/getusernames", getUsernames);
router.get("/getActiveRooms", getActiveRooms);
router.get("/lobbies", lobbiesHandler);
router.get("/leaderboard", leaderboardHandler);
router.post("/wallet", walletHandler);
router.post("/myActiveRoom", myActiveRoomHandler);
router.post("/shop/buy", shopBuyHandler);
router.post("/friends/list", friendsListHandler);
router.post("/friends/action", friendActionHandler);
router.post("/avatar", uploadAvatarHandler);
router.get("/avatar/img/:username", getAvatarImageHandler);

export default router;
