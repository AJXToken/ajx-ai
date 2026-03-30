import { Suspense } from "react";
import HelpClient from "./HelpClient";

export default function HelpPage() {
  return (
    <Suspense fallback={null}>
      <HelpClient />
    </Suspense>
  );
}
