import { port } from "../../ports.js";
import { httpFunction } from "../helpers/http_function.js";
import { classes } from "../helpers/variables.js";

export async function handleGetUsername() {
  const data = await httpFunction(`${port}/getusernames`);

  classes.heart.src = "/pics/heart.svg";
  classes.heart.width = 20;
  classes.heart.height = 20;
  classes.heartWrapPlayer1.innerHTML = ``;
  classes.heartWrapPlayer2.innerHTML = ``;

  if (!data.information[0]) {
    classes.username1.forEach((element) => (element.innerText = "Waiting on the opponent to join"));
  } else {
    const player1 = data.information[0];
    classes.username1.forEach(
      (element) => (element.innerText = player1.username)
    );
    for (let i = 0; i < player1.health; i++) {
      const clone = classes.heart.cloneNode(true);
      classes.heartWrapPlayer1.appendChild(clone);
    }
  }

  if (!data.information[1]) {
    classes.username2.forEach(
      (element) => (element.innerText = "Waiting on the opponent to join")
    );
  } else {
    const player2 = data.information[1];
    classes.username2.forEach(
      (element) => (element.innerText = player2.username)
    );
    for (let i = 0; i < player2.health; i++) {
      const clone = classes.heart.cloneNode(true);
      classes.heartWrapPlayer2.appendChild(clone);
    }
  }

  const gameData = await httpFunction(`${port}/getGameState`);
  localStorage.setItem("gameStatus", `${gameData.gameState}`);

  if (localStorage.getItem("gameStatus") === "true") {
    classes.button.remove();
  }
}
