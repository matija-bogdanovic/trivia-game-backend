import { handleButtonClick, handleGameStart, } from "./functions/handle_game_start.js";
import { handleGetUsername } from "./functions/handle_get_usernames.js";
import { httpFunction } from "./helpers/http_function.js";
import { classes } from "./helpers/variables.js";
document.addEventListener("DOMContentLoaded", () => {
    const handleRoundStart = (roundName, delay) => {
        setTimeout(() => {
            classes.overlay.style.display = "none";
            classes.circle.style.backgroundColor = "#00FF00";
            classes.circle.style.cursor = "pointer";
            const onClick = async () => {
                classes.circle.removeEventListener("click", onClick);
                classes.circle.style.cursor = "not-allowed";
                classes.circle.style.backgroundColor = "gray";
                try {
                    const response = await httpFunction("http://localhost:3000/pressedCircle", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify({ round: roundName }),
                    });
                    classes.wss.send(JSON.stringify({ roundEnded: true }));
                }
                catch (err) {
                    console.error("HTTP ERROR:", err);
                }
            };
            classes.circle.addEventListener("click", onClick);
        }, delay);
    };
    classes.wss.onopen = async () => {
        try {
            const startStatus = await httpFunction("http://localhost:3000/getGameState");
            const numberOfPlayers = await httpFunction("http://localhost:3000/playerNum");
            if (numberOfPlayers.usernames.length < 2) {
                classes.button.disabled = true;
            }
            handleGetUsername();
            if (startStatus.gameState) {
                classes.wss.send(JSON.stringify({ gameRound: "getGameRound" }));
            }
        }
        catch (err) {
            console.error("Error during WebSocket open logic:", err);
        }
    };
    classes.wss.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        console.log(msg);
        if (msg === null || msg === void 0 ? void 0 : msg.gameStarted) {
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
            classes.button.hidden = true;
        }
        if ((msg === null || msg === void 0 ? void 0 : msg.type) === "updatedNames") {
            classes.heartWrapPlayer1.innerHTML = ``;
            classes.heartWrapPlayer2.innerHTML = ``;
            console.log(msg);
            for (let i = 0; i < msg.props[0].health; i++) {
                const clone = classes.heart.cloneNode(true);
                classes.heartWrapPlayer1.appendChild(clone);
            }
            classes.username1.forEach((username) => (username.innerText = `${msg.props[0].username}`));
            classes.username2.forEach((username) => (username.innerText = `${msg.props[1].username}`));
            for (let i = 0; i < msg.props[1].health; i++) {
                const clone = classes.heart.cloneNode(true);
                classes.heartWrapPlayer2.appendChild(clone);
            }
        }
        if (msg === null || msg === void 0 ? void 0 : msg.matchEnd) {
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
    if (localStorage.getItem("gameStatus") === "true") {
        classes.button.remove();
    }
});
//# sourceMappingURL=game.js.map