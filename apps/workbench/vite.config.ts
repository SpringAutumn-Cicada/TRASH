import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Development HTTP and HMR share the workbench server's single port.
export default defineConfig({ plugins: [react()] });
