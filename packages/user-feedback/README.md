# @zenel/user-feedback

Shared **Report error / idea** stack for Vercel apps: React modal, client submit, Neon + Blob + Resend handlers.

Canonical location (deployed with bluring): `bluring/packages/user-feedback`.

## Install

**Inside bluring** (already wired):

```json
"@zenel/user-feedback": "file:./packages/user-feedback"
```

**Other local apps:**

```json
"@zenel/user-feedback": "file:../bluring/packages/user-feedback"
```

Each app uses **its own** `POSTGRES_URL`, `BLOB_READ_WRITE_TOKEN`, `RESEND_API_KEY`, etc.

## Client

```tsx
import { FeedbackModal } from "@zenel/user-feedback/client";
import "@zenel/user-feedback/styles.css";

<FeedbackModal
  open={open}
  screenshotDataUrl={shot}
  toolId="myTool"
  toolLabel="My tool"
  journalMarkdown={formatJournal(...)}
  journal={snapshot}
  onClose={...}
/>
```

## Server (Vercel)

```ts
import { createFeedbackSaveHandler } from "@zenel/user-feedback/server";

export default createFeedbackSaveHandler({
  appName: "MyApp",
  authorize: (req) => hasValidAccessCookie(req.headers?.cookie),
  ensureEnv: ensureProjectEnv,
});
```

Same pattern for `createFeedbackListHandler`.
