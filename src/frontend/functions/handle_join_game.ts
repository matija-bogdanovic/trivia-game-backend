import { httpFunction } from "../helpers/http_function.js";

export async function handleJoinGame() {
  const nameSetter = document.getElementById("nameSetter") as HTMLInputElement;
  const userCountEl = document.getElementById(
    "userCount"
  ) as HTMLElement | null;
  const username = nameSetter.value.trim();
  if (!username) {
    userCountEl.innerText = "Please enter a username.";
    return;
  } else if (username.length < 3) {
    userCountEl.innerText = "Username mustn't be shorter than 3 letters";
    return;
  }
  await httpFunction(process.env.CLIENT_ORIGIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username: username }),
  })
    .then((data) => {
      if (data.error === "Kurcina!") {
        userCountEl.innerText =
          "Kurac bre ne moze to ime da se sacuva, probaj drugo.";
      } else if (data.success === true) {
        userCountEl.innerText = "";
        window.location.href = "/game.html";
      }
    })
    .catch((e) => console.log("Error: ", e));
}
