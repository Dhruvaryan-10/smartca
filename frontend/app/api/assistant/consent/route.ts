import { handleConsentHttp } from "@/services/assistant/consent-http";
import { getSessionUserId } from "@/services/session";

// The signed-in person's own assistant consent: GET its status, POST a grant of the server's terms, DELETE (withdraw) it. The route
// passes only the request and the server-session reader; the user, profile, recipient, data classes and validity window are decided on
// the server (services/assistant/consent-http.ts).
export async function GET(request: Request) {
  return handleConsentHttp(request, { getSessionUserId });
}

export async function POST(request: Request) {
  return handleConsentHttp(request, { getSessionUserId });
}

export async function DELETE(request: Request) {
  return handleConsentHttp(request, { getSessionUserId });
}
