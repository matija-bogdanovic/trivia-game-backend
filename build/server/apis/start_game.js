import { client } from "../middleware/connections.js";
import { helperFunction } from "./websocket_functions.js";
export async function startGame(req, res) {
    if (req.body.gameStarted === true) {
        await client.set("gameStatus", "true");
        (await client.json.set("rounds", `$["First\ Round"]`, {
            winner: "",
            state: "started",
        }));
        helperFunction({
            gameStarted: true,
            roundCount: "First Round",
            gameRound: "getGameRound",
        });
        return;
    }
}
//# sourceMappingURL=start_game.js.map