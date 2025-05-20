import { client } from "../middleware/connections";
export async function gameFlow(res, req) {
    const getRounds = (await client.json.get("rounds"));
    const parsedRounds = JSON.parse(getRounds);
    Array.of(parsedRounds).some((element) => console.log(element === parsedRounds.state));
    console.log(Object.values(parsedRounds)[0]);
}
//# sourceMappingURL=game_flow.js.map