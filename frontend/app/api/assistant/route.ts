import { handleAssistantHttp } from "@/services/assistant/http";
import { getSessionUserId } from "@/services/session";

// The assistant's one HTTP entry point. It passes the request and the server-session reader to the assistant's HTTP boundary
// (services/assistant/http.ts) and nothing else: the user comes from the session, and the configuration, provider, profile, tools,
// data classes, consent and limits are all decided on the server. It fails closed while the configuration refuses external mode.
export async function POST(request: Request) {
  return handleAssistantHttp(request, { getSessionUserId });
}
