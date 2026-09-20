import { computed } from "vue";
import { useRoute } from "vue-router";
import { pages } from "../shared/examples.ts";

export type ToolPage = {
  page: string;
  title: string;
  path: string;
  group: string;
};
export const tools: ToolPage[] = pages.map(([page, title]) => ({
  page,
  title,
  path: `/create/${page.replace(":", "/").toLowerCase().replaceAll("_", "-")}`,
  group: page.startsWith("apparel:")
    ? "apparel"
    : page.startsWith("video:")
      ? "video"
      : page,
}));
export const menu = [
  { group: "main_image", title: "商品主图", icon: "image" },
  { group: "detail_page", title: "详情页", icon: "layout" },
  { group: "ecommerce_poster", title: "电商套图", icon: "layers" },
  { group: "video", title: "AI 视频", icon: "video" },
  { group: "aigc", title: "无限画布", icon: "canvas" },
  { group: "apparel", title: "AI 服装", icon: "shirt" },
  { group: "translation", title: "图片翻译", icon: "translate" },
].map((item) => {
  const target = tools.find((tool) => tool.group === item.group);
  if (!target) throw new Error(`Missing tool group: ${item.group}`);
  return { ...item, path: target.path };
});
export const accountPages = [
  { path: "/works", title: "我的作品", icon: "folder", section: "works" },
  { path: "/users", title: "用户管理", icon: "users", section: "users" },
  { path: "/credits", title: "算力记录", icon: "wallet", section: "credits" },
  {
    path: "/integration",
    title: "接入设置",
    icon: "settings",
    section: "integration",
  },
  { path: "/api", title: "API 调试", icon: "code", section: "api" },
];
export const apiTestPage = {
  path: "/api-test",
  title: "API 测试",
  icon: "code",
  section: "api-test",
};
export function usePage() {
  const route = useRoute();
  return computed(() => ({
    title: String(route.meta.title || "创作工作台"),
    group: String(route.meta.group || ""),
    sdkPage: typeof route.meta.sdkPage === "string" ? route.meta.sdkPage : null,
    section: String(route.meta.section || ""),
    resourceId:
      typeof route.query.work === "string" && route.meta.sdkPage === "aigc"
        ? route.query.work
        : undefined,
  }));
}
