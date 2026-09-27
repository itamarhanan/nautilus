import type { ReactNode } from "react";
import { LayerProvider } from "@astryxdesign/core/Layer";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <Theme theme={neutralTheme} mode="system">
      <LayerProvider toast={{ position: "bottomEnd", maxVisible: 3 }}>{children}</LayerProvider>
    </Theme>
  );
}
