import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("guide", "routes/guide.tsx"),
  route("wiki/:lang?/:slug?", "routes/wiki.tsx"),
] satisfies RouteConfig;
