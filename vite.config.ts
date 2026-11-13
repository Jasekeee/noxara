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

export default defineConfig(({ mode }) => ({
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
  server: { port: 5180, strictPort: true },
  plugins: [absoluteSocialImage(loadEnv(mode, process.cwd(), "VITE_").VITE_PUBLIC_URL || process.env.VITE_PUBLIC_URL)],
}));
