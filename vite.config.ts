import { defineConfig, loadEnv, type Plugin } from "vite";

/** og:image / twitter:image must be absolute for crawlers: set VITE_PUBLIC_URL (e.g. https://noxara.example) at build time.
 *  Unset = left relative ("/og.png"), which works on the same origin but not for link-preview crawlers. */
function absoluteSocialImage(base: string | undefined): Plugin {
  return {
    name: "absolute-social-image",
    transformIndexHtml(html) {
      if (!base) return html;
      const root = base.replace(/\/+$/, "");
      return html.replace(/(<meta (?:property="og:image"|name="twitter:image") content=")\/og\.png(")/g, `$1${root}/og.png$2`);
    },
  };
}

/** The 3D chunks are dynamic imports (loaded after the title paints): preload them from the HTML head so they
 *  download in parallel with the entry script instead of after it. */
function preloadGameChunks(): Plugin {
  return {
    name: "preload-game-chunks",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const files = Object.values(ctx.bundle ?? {})
          .filter((c) => c.type === "chunk" && /^assets\/(three\.module|game)-[\w-]+\.js$/.test(c.fileName) && c.code.length > 5000)
          .map((c) => c.fileName);
        const links = files.map((f) => `<link rel="modulepreload" crossorigin href="/${f}">`).join("\n    ");
        return links ? html.replace("</head>", `    ${links}\n  </head>`) : html;
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
  server: { port: 5180, strictPort: true },
  plugins: [preloadGameChunks(), absoluteSocialImage(loadEnv(mode, process.cwd(), "VITE_").VITE_PUBLIC_URL || process.env.VITE_PUBLIC_URL)],
}));
