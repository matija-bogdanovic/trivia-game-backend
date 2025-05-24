import { port } from "../ports.js";
import {
  handleButtonClick,
  handleGameStart,
} from "./functions/handle_game_start.js";
import { handleGetUsername } from "./functions/handle_get_usernames.js";
import { httpFunction } from "./helpers/http_function.js";
import { classes } from "./helpers/variables.js";

document.addEventListener("DOMContentLoaded", () => {
  const handleRoundStart = (roundName: string, delay: number) => {
    setTimeout(() => {
      classes.overlay.style.display = "none";
      classes.circle.style.backgroundColor = "#00FF00";
      classes.circle.style.cursor = "pointer";

      const onClick = async () => {
        classes.circle.removeEventListener("click", onClick);

        classes.circle.style.cursor = "not-allowed";
        classes.circle.style.backgroundColor = "gray";

        try {
          await httpFunction(`${port}/pressedCircle`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ round: roundName }),
          });

          classes.wss.send(JSON.stringify({ roundEnded: true }));
        } catch (err) {
          console.error("HTTP ERROR:", err);
        }
      };

      classes.circle.addEventListener("click", onClick);
    }, delay);
  };

  classes.wss.onopen = async () => {
    classes.wss.send(JSON.stringify({ joined: true }));
    try {
      const startStatus = await httpFunction(`${port}/getGameState`);
      const numberOfPlayers = await httpFunction(`${port}/playerNum`);
      if (numberOfPlayers.usernames.length < 2) {
        classes.button.disabled = true;
      }
      handleGetUsername();
      if (startStatus.gameState) {
        classes.wss.send(JSON.stringify({ gameRound: "getGameRound" }));
      }
    } catch (err) {
      console.error("Error during WebSocket open logic:", err);
    }
  };

  classes.wss.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg?.gameStarted) {
      classes.roundCount.innerText = msg.roundCount;

      const preDelay = 2000;
      const delay = msg.randomNumber || 1000;

      classes.circle.style.cursor = "not-allowed";
      classes.overlay.style.display = "flex";
      classes.countdown.innerText = `${msg.roundCount} begins soon!`;
      setTimeout(() => {
        classes.overlay.style.display = "none";
        handleRoundStart(msg.roundCount, delay);
      }, preDelay);
      classes.button.remove();
    }
    if (msg?.roundEnded) {
      classes.circle.style.backgroundColor = "gray";
      const newCircle = classes.circle.cloneNode(true);

      classes.circle.replaceWith(newCircle);
      classes.circle = newCircle; // Now update your reference
    }

    if (msg?.type === "updatedNames") {
      classes.heartWrapPlayer1.innerHTML = ``;
      classes.heartWrapPlayer2.innerHTML = ``;
      for (let i = 0; i < msg.props[0].health; i++) {
        const clone = classes.heart.cloneNode(true);
        classes.heartWrapPlayer1.appendChild(clone);
      }
      classes.username1.forEach(
        (username) => (username.innerText = `${msg.props[0].username}`)
      );

      if (msg?.props[1] === undefined) {
        return;
      } else {
        classes.username2.forEach(
          (username) => (username.innerText = `${msg.props[1].username}`)
        );
        for (let i = 0; i < msg.props[1].health; i++) {
          const clone = classes.heart.cloneNode(true);
          classes.heartWrapPlayer2.appendChild(clone);
        }
      }
      classes.button.disabled = false;
    }

    if (msg?.matchEnd) {
      window.location.href = "endscreen.html";
    }

    if (msg.started) {
      handleGameStart();
    }
  };
  classes.wss.onclose = () => {
    console.log("someone logged out");
  };

  classes.overlay.style.display = "none";
  classes.circle.style.cursor = "pointer";

  classes.button.addEventListener("click", async () => {
    handleButtonClick();
  });
});
