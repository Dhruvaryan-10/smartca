import { handleConsentDisclosureHttp } from "@/services/assistant/consent-http";
import { getSessionUserId } from "@/services/session";

// What an external assistant run would send and withhold, for the signed-in person, before they grant consent. Derived on the server from
// the egress inventory through the access plan (services/assistant/consent-http.ts); nothing in the request changes it.
export async function GET(request: Request) {
  return handleConsentDisclosureHttp(request, { getSessionUserId });
}
