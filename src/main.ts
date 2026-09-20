import { createApp } from "vue";
import App from "./App.vue";
import { createPlatformRouter } from "./router.ts";
import "./style.css";

const router = createPlatformRouter();
const app = createApp(App).use(router);
void router.isReady().then(() => app.mount("#app"));
