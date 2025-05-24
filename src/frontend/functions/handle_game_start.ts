import { port } from "../../ports.js";
import { httpFunction } from "../helpers/http_function.js";
import { classes } from "../helpers/variables.js";

export async function handleGameStart() {
  classes.button.remove();
  let i = 3;
  classes.overlay.style.display = "flex";
  const interval = setInterval(() => {
    i--;
    classes.countdown.innerText = `You're up! ${i}`;
    if (i === 0) {
      clearInterval(interval);
      classes.overlay.style.display = "none";
    }
  }, 1000);
}

export async function handleButtonClick() {
  const startGameData = await httpFunction(`${port}/startGame`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ gameStarted: true }),
  });
  
  classes.wss.send(JSON.stringify({ gameStarted: startGameData.gameStarted }));
}
