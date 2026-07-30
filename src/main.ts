import { Application, Text } from "pixi.js";

(async () => {
  const app = new Application();
  await app.init({ background: "#1a1626", resizeTo: window });
  document.getElementById("pixi-container")!.appendChild(app.canvas);

  const placeholder = new Text({
    text: "c(at)rpg — under construction",
    style: { fill: 0xf0e6d2, fontSize: 28, fontFamily: "monospace" },
  });
  placeholder.anchor.set(0.5);
  placeholder.position.set(app.screen.width / 2, app.screen.height / 2);
  app.stage.addChild(placeholder);
})();
