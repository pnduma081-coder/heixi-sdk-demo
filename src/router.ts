import { createRouter, createWebHistory } from "vue-router";
import AccountPages from "./AccountPages.vue";
import ApiPanel from "./ApiPanel.vue";
import ApiTestPage from "./ApiTestPage.vue";
import { accountPages, apiTestPage, tools } from "./navigation.ts";
import SdkPanel from "./SdkPanel.vue";

export function createPlatformRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: "/", redirect: tools[0].path },
      {
        path: apiTestPage.path,
        component: ApiTestPage,
        meta: {
          title: apiTestPage.title,
          section: apiTestPage.section,
          group: "api-test",
        },
      },
      ...tools.map((tool) => ({
        path: tool.path,
        component: SdkPanel,
        meta: { title: tool.title, group: tool.group, sdkPage: tool.page },
      })),
      ...accountPages.map((page) => ({
        path: page.path,
        component: page.section === "api" ? ApiPanel : AccountPages,
        meta: { title: page.title, section: page.section },
      })),
      { path: "/:pathMatch(.*)*", redirect: tools[0].path },
    ],
  });
}
