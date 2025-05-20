import { httpFunction } from "../variables/http_function.js";
import { classes } from "../variables/variables.js";
export async function handleJoin() {
    const data = await httpFunction("http://localhost:3000/getusernames");
    classes.heart.src = "/pics/heart.svg";
    classes.heart.width = 20;
    classes.heart.height = 20;
    classes.heartWrapPlayer1.innerHTML = ``;
    classes.heartWrapPlayer2.innerHTML = ``;
    if (!data.information[0]) {
        classes.username1.forEach((element) => (element.innerText = "Joining..."));
    }
    else {
        const player1 = data.information[0];
        classes.username1.forEach((element) => (element.innerText = player1.username));
        for (let i = 0; i < player1.health; i++) {
            const clone = classes.heart.cloneNode(true);
            classes.heartWrapPlayer1.appendChild(clone);
        }
    }
    if (!data.information[1]) {
        classes.username2.forEach((element) => (element.innerText = "Waiting on the opponent to join"));
    }
    else {
        const player2 = data.information[1];
        classes.username2.forEach((element) => (element.innerText = player2.username));
        for (let i = 0; i < player2.health; i++) {
            const clone = classes.heart.cloneNode(true);
            classes.heartWrapPlayer2.appendChild(clone);
        }
    }
    const gameData = await httpFunction("http://localhost:3000/getgamestate");
    localStorage.setItem("gameStatus", `${gameData.gameState}`);
    if (localStorage.getItem("gameStatus") === "true") {
        classes.button.remove();
    }
    if (classes.circle.style.backgroundColor === "#00FF00") {
        classes.circle.addEventListener("click", async () => {
            await httpFunction("http://localhost:3000/pressedCircle", {
                method: "POST",
                body: JSON.stringify({ pressedBy: document.cookie }),
                headers: {
                    "Content-Type": "application/json",
                },
            });
        });
    }
    else {
        classes.circle.style.cursor = "not-allowed";
    }
}
//# sourceMappingURL=handle_join.js.map