# pi-auto-resume

A [pi](https://github.com/earendil-works/pi) extension that waits for a provider usage limit to reset. Then it resumes the interrupted task on the same model.

## Install

```sh
pi install git:github.com/neighborhood999/pi-auto-resume
```

## Supported providers

- `anthropic`
- `openai-codex`

The extension does not resume billing, credit, or plan errors. Those errors do not reset over time.

## How it works

1. A turn stops because of a usage limit.
2. The extension reads the reset time from the provider response.
3. The extension shows a countdown.
4. The extension waits until the reset time, plus `bufferMs` and a random delay of up to `jitterMs`.
5. The extension sends `resumePrompt` to the same provider and model.

If the provider does not send a reset time, the extension waits `pollIntervalMs`. Each new limit after a resume counts as one more attempt. After `maxAttempts`, the extension stops.

If pi restarts during a wait, the extension asks you to re-arm the resume. It re-arms only when the current model is the model of the interrupted turn.

## Commands

| Command                    | Action                                                     |
| -------------------------- | ---------------------------------------------------------- |
| `/autoresume` or `status`  | Show the state and the attempt count.                      |
| `/autoresume on`           | Enable auto-resume for this session.                       |
| `/autoresume off`          | Disable auto-resume for this session.                      |
| `/autoresume off --global` | Disable auto-resume and save `"enabled": false` to config. |
| `/autoresume now`          | Stop the wait and resume immediately.                      |
| `/autoresume cancel`       | Cancel the scheduled resume.                               |

## Configuration

Put the settings in `~/.pi/agent/auto-resume.json`. All fields are optional.

| Field            | Default    | Description                                                |
| ---------------- | ---------- | ---------------------------------------------------------- |
| `enabled`        | `true`     | Enable auto-resume in all sessions.                        |
| `maxAttempts`    | `6`        | Maximum number of resume attempts.                         |
| `bufferMs`       | `45000`    | Time to wait after the reset time.                         |
| `jitterMs`       | `15000`    | Maximum random delay after `bufferMs`.                     |
| `pollIntervalMs` | `600000`   | Time to wait when the provider does not send a reset time. |
| `resumePrompt`   | (built-in) | Prompt that the extension sends when it resumes the task.  |

Example:

```json
{
  "maxAttempts": 10,
  "bufferMs": 60000,
  "resumePrompt": "Continue where you left off."
}
```

The extension reads this file when a session starts. If a field has an incorrect value, the extension uses the default for that field.

## Development

```sh
pnpm install
pnpm check
```

## License

[MIT](LICENSE)
