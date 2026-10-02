export default defineNuxtConfig({
  devtools: { enabled: false },
  compatibilityDate: "2025-07-15",
  // 离线工具：store 依赖 localStorage / crypto，采用 SPA 模式避免 naive-ui 的 SSR 样式挂载问题
  ssr: false,
  modules: ["@pinia/nuxt", "@vueuse/nuxt", "@nuxtjs/i18n"],
  build: { transpile: ["naive-ui", "vueuc", "@css-render/vue3-ssr"] },
  css: ["~/assets/main.css"],
  i18n: {
    locales: [{ code: "zh", language: "zh-CN", name: "中文", file: "zh.json" }],
    defaultLocale: "zh",
    strategy: "no_prefix",
    langDir: "locales",
    bundle: { optimizeTranslationDirective: false }
  },
  app: {
    head: {
      title: "灾后需求评估与任务分派",
      meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }]
    }
  }
});
