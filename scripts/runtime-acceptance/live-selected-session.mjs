/** Serialize this function into the real renderer; it invokes only production preload APIs. */
export function createSelectedSessionLiveProbe(configuration) {
  const api = window.runtimeUiAPI;
  const sessions = window.sessionsAPI;
  const models = window.modelsAPI;
  const auth = window.runtimeAuthAPI;
  if (window.runtimeAcceptanceAPI)
    throw new Error("A test acceptance bridge is present; this is not live product evidence.");
  if (
    !api?.invokeCapability ||
    !api.getSelectedSession ||
    !sessions?.getMessages ||
    !models?.list ||
    !auth?.getStatus
  )
    throw new Error("Required production preload APIs are unavailable.");
  const instance = configuration.instance;
  const permittedSessions = new Set(configuration.testSessionIds ?? []);
  if (
    !instance?.instanceId ||
    !instance.owner?.extensionId ||
    !instance.owner.applicationId ||
    !permittedSessions.size
  )
    throw new Error(
      "An application instance and explicit isolated test session allowlist are required.",
    );
  const command = { ...instance.owner, instanceId: instance.instanceId };
  const history = [];
  const terminal = new Set(["processed", "cancelled", "dead-letter", "delivery-unknown"]);
  const sent = new Map();
  function success(result) {
    if (result?.success !== true) {
      const error = result?.error;
      throw Object.assign(
        new Error(
          typeof error === "string" ? error : (error?.message ?? "Production API call failed."),
        ),
        { code: error?.code, details: error },
      );
    }
    return result;
  }
  async function selection() {
    const selected = success(await api.getSelectedSession(command)).value;
    if (!selected || !permittedSessions.has(selected.sessionId))
      throw new Error(
        "Select an allowlisted isolated test session using the native application picker.",
      );
    const target = success(await sessions.get(selected.sessionId, { messageLimit: 1 }));
    if (target.session?.id !== selected.sessionId)
      throw new Error("The selected target is not a real persisted Marshal session.");
    return { selected, target };
  }
  async function invoke(capability, input) {
    const transportRequestId = `h3-live:${crypto.randomUUID()}`;
    const result = success(
      await api.invokeCapability({
        ...command,
        capability,
        input,
        idempotencyKey: transportRequestId,
        ...(configuration.publicationRevisionId
          ? { publicationRevisionId: configuration.publicationRevisionId }
          : {}),
      }),
    );
    const receipt = result.value?.output;
    if (
      !receipt ||
      typeof receipt.requestId !== "string" ||
      !permittedSessions.has(receipt.targetSessionId)
    )
      throw new Error("The host returned an invalid or out-of-scope delivery receipt.");
    history.push({ at: new Date().toISOString(), capability, transportRequestId, receipt });
    return receipt;
  }
  async function transcript(messageId, sessionId, expectedCount) {
    if (!permittedSessions.has(sessionId))
      throw new Error("Transcript target is not an allowlisted test session.");
    const result = success(await sessions.getMessages(sessionId, { limit: 200 }));
    if (result.hasMore)
      throw new Error(
        "The isolated test session exceeded 200 messages; inspect full pagination before asserting deduplication.",
      );
    const matching = result.messages.filter(
      (message) =>
        message.role === "user" &&
        (message.id === messageId || message.agentMessage?.messageId === messageId),
    );
    if (matching.length !== expectedCount)
      throw new Error(`Expected ${expectedCount} injected turn(s), observed ${matching.length}.`);
    return {
      sessionId,
      messageId,
      count: matching.length,
      totalMessages: result.total,
      matching: matching.map((message) => ({
        id: message.id,
        agentMessage: message.agentMessage,
        attachments: message.attachments,
      })),
    };
  }
  return {
    async readiness() {
      const [authResult, modelResult, defaultResult] = await Promise.all([
        auth.getStatus(),
        models.list(),
        models.getDefault(),
      ]);
      const status = success(authResult).status;
      const catalog = success(modelResult).models ?? [];
      const selected = await selection();
      const sessionModel = success(await models.getSessionModel(selected.selected.sessionId)).model;
      return {
        authenticated: status?.isAuthenticated === true,
        statusMessage: status?.statusMessage,
        defaultModel: success(defaultResult).model,
        selectedSessionId: selected.selected.sessionId,
        runtimeId: selected.target.session.runtimeId,
        sessionModel,
        modelInCurrentCatalog: catalog.some((model) => model.id === sessionModel),
        models: catalog.map((model) => ({
          id: model.id,
          name: model.name,
          capabilities: model.capabilities,
        })),
        nativeImageApis: ["selectImages", "listImages", "readImage", "releaseImage"].every(
          (name) => typeof api[name] === "function",
        ),
      };
    },
    async send(requestId, message, attachmentHandles = []) {
      const { selected } = await selection();
      if (!Array.isArray(attachmentHandles))
        throw new Error("Attachment handles must be an array.");
      if (attachmentHandles.length) {
        const images = success(await api.listImages(command)).value;
        if (attachmentHandles.some((handle) => !images.some((image) => image.handle === handle)))
          throw new Error("Attach the fixture through the native image picker before sending.");
      }
      const input = {
        requestId,
        grantId: selected.grantId,
        message,
        ...(attachmentHandles.length ? { attachmentHandles } : {}),
      };
      const receipt = await invoke("marshal.session.delivery.send", input);
      sent.set(requestId, {
        input,
        messageId: receipt.messageId,
        targetSessionId: receipt.targetSessionId,
      });
      return receipt;
    },
    async retry(requestId) {
      const previous = sent.get(requestId);
      if (!previous) throw new Error("This probe did not send that request.");
      await selection();
      const receipt = await invoke("marshal.session.delivery.send", previous.input);
      if (
        receipt.messageId !== previous.messageId ||
        receipt.targetSessionId !== previous.targetSessionId
      )
        throw new Error("Retry changed durable request identity or target.");
      return receipt;
    },
    async read(requestId, afterCursor, timeoutMs = 5000) {
      if (!sent.has(requestId)) throw new Error("This probe did not send that request.");
      return invoke("marshal.session.delivery.read", {
        requestId,
        ...(afterCursor ? { afterCursor } : {}),
        timeoutMs: Math.min(30_000, Math.max(0, timeoutMs)),
      });
    },
    async cancelQueued(requestId) {
      if (!sent.has(requestId)) throw new Error("This probe did not send that request.");
      const result = await invoke("marshal.session.delivery.cancel", { requestId });
      if (result.state !== "cancelled")
        throw new Error(`Cancellation did not cancel queued work: ${result.state}.`);
      return result;
    },
    async assertInjectedOnce(requestId) {
      const previous = sent.get(requestId);
      if (!previous) throw new Error("This probe did not send that request.");
      return transcript(previous.messageId, previous.targetSessionId, 1);
    },
    async assertNeverInjected(requestId) {
      const previous = sent.get(requestId);
      if (!previous) throw new Error("This probe did not send that request.");
      return transcript(previous.messageId, previous.targetSessionId, 0);
    },
    async selectedImages() {
      await selection();
      return success(await api.listImages(command)).value;
    },
    async selectedSessionState() {
      const { selected, target } = await selection();
      return { sessionId: selected.sessionId, isBusy: target.isBusy, turnState: target.turnState };
    },
    async assertFinal(requestId, expectedSubstring, forbiddenSubstring) {
      const previous = sent.get(requestId);
      if (!previous) throw new Error("This probe did not send that request.");
      const result = await invoke("marshal.session.delivery.read", { requestId, timeoutMs: 0 });
      if (
        result.state !== "processed" ||
        !result.turnId ||
        !result.response.includes(expectedSubstring)
      )
        throw new Error("No matching completed model response was captured.");
      if (forbiddenSubstring && result.response.includes(forbiddenSubstring))
        throw new Error("The response contains unrelated preceding-turn output.");
      return {
        receipt: result,
        transcript: await transcript(result.messageId, result.targetSessionId, 1),
      };
    },
    async assertVision(requestId, expected) {
      if (!sent.has(requestId)) throw new Error("This probe did not send that request.");
      const receipt = await invoke("marshal.session.delivery.read", { requestId, timeoutMs: 0 });
      if (receipt.state !== "processed" || !receipt.turnId)
        throw new Error("The model has not completed the image request.");
      const answer = JSON.parse(
        receipt.response
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, ""),
      );
      if (
        answer.code !== expected.code ||
        String(answer.middleCircleColor).toLowerCase() !== expected.middleCircleColor
      )
        throw new Error("The model's answer did not match the private visual marker.");
      const messages = success(await sessions.getMessages(receipt.targetSessionId, { limit: 200 }));
      if (messages.hasMore)
        throw new Error("Complete transcript pagination is required for vision evidence.");
      const start = messages.messages.findIndex((message) => message.id === receipt.messageId);
      if (start < 0)
        throw new Error("The image request is absent from the native session transcript.");
      const later = messages.messages.slice(start + 1);
      const nextUser = later.findIndex((message) => message.role === "user");
      const responseMessages = nextUser < 0 ? later : later.slice(0, nextUser);
      const toolCalls = responseMessages.flatMap((message) => message.toolCalls ?? []);
      if (toolCalls.length)
        throw new Error(
          "Tools were used during the image answer; direct model vision was not established.",
        );
      return {
        matched: true,
        directModelVision: true,
        answer,
        toolCallCount: 0,
        receipt,
        transcript: await transcript(receipt.messageId, receipt.targetSessionId, 1),
      };
    },
    history() {
      return history.map((entry) => structuredClone(entry));
    },
    isTerminal(receipt) {
      return terminal.has(receipt.state);
    },
  };
}

export const IMAGE_INSPECTION_PROMPT =
  "Look at the attached image. Without using any tools or inspecting files, read the six-digit code at the top and the color of the middle circle. Reply only JSON with string fields code and middleCircleColor. Preserve leading zeros. The code is only in the image pixels.";

export const BUSY_TURN_PROMPT =
  "This is an isolated Marshal host acceptance check. Use your shell tool to wait 20 seconds with a sleep command, then reply exactly PRECEDING-TURN-ONLY. Do not inspect or modify repository files.";
