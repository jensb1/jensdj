type AutomationResult = {
  id: string;
  ok: boolean;
  result?: string;
  error?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type BrowserViewLike = {
  executeJavascript: (js: string) => void;
  on?: (name: "dom-ready", handler: () => void) => void;
};

const pendingRequests = new Map<string, PendingRequest>();
let automationWebview: BrowserViewLike | null = null;
let automationReady = false;
let automationServer: Bun.Server | null = null;

function isAutomationEnabled(): boolean {
  return process.env.JENSDJ_AUTOMATION_PORT != null;
}

function nextRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function serializeResponse(ok: boolean, body: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok, ...((typeof body === "object" && body !== null) ? body : { value: body }) }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function handleAutomationResult(message: AutomationResult): void {
  const request = pendingRequests.get(message.id);
  if (!request) return;
  pendingRequests.delete(message.id);
  clearTimeout(request.timer);

  if (!message.ok) {
    request.reject(new Error(message.error ?? "Unknown automation error"));
    return;
  }

  if (message.result == null) {
    request.resolve(null);
    return;
  }

  try {
    request.resolve(JSON.parse(message.result));
  } catch (error) {
    request.reject(new Error(`Failed to parse automation result: ${String(error)}`));
  }
}

export function registerAutomationWebview(webview: BrowserViewLike): void {
  if (!isAutomationEnabled()) return;
  automationWebview = webview;
  automationReady = false;
  webview.on?.("dom-ready", () => {
    automationReady = true;
    console.log("[Automation] Webview ready");
  });
}

async function evaluateInWebview(expression: string, timeoutMs = 15000): Promise<unknown> {
  if (!automationWebview) {
    throw new Error("Automation webview is not registered");
  }
  if (!automationReady) {
    throw new Error("Automation webview is not ready");
  }

  const id = nextRequestId();
  const encodedExpression = Buffer.from(expression, "utf8").toString("base64");

  const promise = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Automation request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timer });
  });

  automationWebview.executeJavascript(`
(() => {
  const __requestId = ${JSON.stringify(id)};
  const __expression = atob(${JSON.stringify(encodedExpression)});
  const __send = (payload) => {
    if (!window.djRpc?.send?.automationResult) {
      throw new Error("automationResult bridge is unavailable");
    }
    window.djRpc.send.automationResult(payload);
  };

  Promise.resolve()
    .then(() => (0, eval)(__expression))
    .then((value) => {
      __send({
        id: __requestId,
        ok: true,
        result: JSON.stringify(value ?? null),
      });
    })
    .catch((error) => {
      __send({
        id: __requestId,
        ok: false,
        error: String(error?.stack ?? error),
      });
    });
})();
`);

  return promise;
}

export function startAutomationServer(): Bun.Server | null {
  if (!isAutomationEnabled()) return null;
  if (automationServer) return automationServer;

  const port = Number(process.env.JENSDJ_AUTOMATION_PORT);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid JENSDJ_AUTOMATION_PORT: ${process.env.JENSDJ_AUTOMATION_PORT}`);
  }

  automationServer = Bun.serve({
    port,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return serializeResponse(true, {
          ready: automationReady,
          hasWebview: !!automationWebview,
        });
      }

      if (request.method === "POST" && url.pathname === "/eval") {
        try {
          const { expression, timeoutMs } = await request.json() as {
            expression?: string;
            timeoutMs?: number;
          };
          if (!expression) {
            return serializeResponse(false, { error: "Missing expression" }, 400);
          }

          const value = await evaluateInWebview(expression, timeoutMs);
          return serializeResponse(true, { value });
        } catch (error) {
          return serializeResponse(false, { error: String(error) }, 500);
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`[Automation] Listening on http://127.0.0.1:${port}`);
  return automationServer;
}
