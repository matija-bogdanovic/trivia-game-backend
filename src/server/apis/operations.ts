import { Router } from "express";
import { signUp } from "./post/register/signup.js";
import logIn from "./post/register/login.js";
import { startGame } from "./post/room_operations/start_game.js";
import { getRoomDetails } from "./get_lobby_details.js";
import { getUsernames } from "./get/get_usernames.js";
import createRoom from "./post/room_operations/create_room.js";
import leaveRoom from "./post/room_operations/leave_room.js";
import joinRoom from "./post/room_operations/join_room.js";
import incorrectAnswer from "./post/room_operations/incorrect_answer.js";
import getRoomCode from "./post/room_operations/get_room_code.js";
import submitAnswer from "./post/room_operations/check_answer.js";
import getActiveRooms from "./get/get_lobby_count.js";
import getRandomQuestions from "./post/room_operations/retrieve_questions.js";

const router = Router();

router.post("/signup", signUp);
router.post("/login", logIn);
router.post("/createRoom", createRoom);
router.post("/joinRoom", joinRoom);
router.post("/startGame", startGame);
router.post("/getRoomCode", getRoomCode);
router.post("/getRoomDetails", getRoomDetails);
router.post("/leaveRoom", leaveRoom);
router.post("/submitAnswer", submitAnswer);
router.post("/incorrectAnswer", incorrectAnswer);
router.post("/getquestion", getRandomQuestions)

router.get("/getusernames", getUsernames);
router.get("/getActiveRooms", getActiveRooms);

export default router;
