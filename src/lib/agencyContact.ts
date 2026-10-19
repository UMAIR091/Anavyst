import type { SupabaseClient } from "@supabase/supabase-js";

// Where Anavyst writes to an agency (its own emails, not white-label ones):
// the contact email it set, else the owner's sign-in email. Service role only
// (reads auth users).
export async function agencyContact(admin: SupabaseClient, agencyId: string): Promise<{ email: string | null; name: string | null }> {
  const { data } = await admin.from("agencies").select("name, contact_email, owner_id").eq("id", agencyId).maybeSingle();
  const name = (data?.name as string | null) ?? null;
  const contact = (data?.contact_email as string | null) ?? null;
  if (contact) return { email: contact, name };

  const ownerId = data?.owner_id as string | undefined;
  if (!ownerId) return { email: null, name };
  const { data: userRes } = await admin.auth.admin.getUserById(ownerId);
  return { email: userRes?.user?.email ?? null, name };
}
