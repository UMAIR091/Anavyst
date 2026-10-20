"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";

// "Remove everywhere" for one saved sign-in (POST /api/connections/remove).
// The confirmation names every client that loses the connection, and says
// plainly whether Anavyst can also cancel the access at the platform.
export function RemoveSignInButton({
  connectionId,
  platform,
  signedInAs,
  clients,
  clientCount,
  revokesAtProvider,
  accessSettings,
}: {
  connectionId: string;
  platform: string;
  signedInAs: string | null;
  /** Client names, for the confirmation. */
  clients: string[];
  /** Distinct clients (names can repeat); the server checks it still matches. */
  clientCount: number;
  revokesAtProvider: boolean;
  accessSettings: { label: string; url: string | null };
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  async function remove() {
    const who = signedInAs ? `${platform} (${signedInAs})` : platform;
    const affected = clients.length
      ? `${clients.length} client${clients.length === 1 ? "" : "s"} will stop syncing ${platform}: ${clients.join(", ")}.`
      : "No client uses it.";
    const platformSide = revokesAtProvider
      ? `Anavyst also cancels its access at ${platform}, unless another of your connections shares the same ${platform} sign-in.`
      : `Anavyst deletes its copy of the access. To remove Anavyst from the ${platform} account as well, use ${accessSettings.label}.`;
    const ok = await confirm({
      title: `Remove ${who} everywhere?`,
      description: `${affected} Their stored ${platform} data is deleted; reports you've already generated are kept. ${platformSide}`,
      confirmLabel: "Remove everywhere",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    const res = await fetch("/api/connections/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId, expectedClients: clientCount }),
    });
    setBusy(false);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json.error ?? "Couldn't remove that sign-in");
      router.refresh();
      return;
    }
    toast.success(
      json.revoked === "revoked" ? `Removed, and access cancelled at ${platform}` : "Removed from Anavyst"
    );
    router.refresh();
  }

  return (
    <Button size="sm" variant="outline" onClick={remove} disabled={busy} className="text-danger-700">
      {busy ? "Removing…" : "Remove everywhere"}
    </Button>
  );
}
