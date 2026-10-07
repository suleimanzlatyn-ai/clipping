# AI Clip Studio

Private, free-first YouTube clipping workflow.

## Stack

- Vercel: frontend + API launcher
- Vercel Sandbox: background video processing
- Groq: primary transcription + clip selection
- Gemini: automatic fallback
- OpenAI: optional paid fallback, disabled by default
- FFmpeg + yt-dlp: video/audio processing

## Environment variables

Required for free operation:
- `GROQ_API_KEY`
- `GEMINI_API_KEY`

Recommended:
```
AI_PROVIDER_ORDER=groq,gemini,openai
ALLOW_PAID_FALLBACK=false
PAID_FALLBACK_MAX_USD=0
```

Never commit API keys to GitHub.

## Deploy

1. Import this repository into your Vercel account.
2. Add the environment variables in Vercel.
3. Deploy.
4. Open the deployed site and paste a YouTube URL you own or are authorized to process.

## Processing flow

YouTube URL -> Sandbox worker -> audio extraction -> timestamped transcription -> AI ranking -> up to 50 distinct clips -> 9:16 FFmpeg rendering -> downloadable MP4s.

The free providers are rate-limited. When a configured provider returns a rate-limit/auth-style response, the worker temporarily disables it and tries the next configured provider. If all configured providers are unavailable, the job reports an error instead of silently spending money.

## Important limitations

- Free API quotas are limited; they are not unlimited.
- The current renderer uses a centered vertical crop. Intelligent face/speaker tracking is a future enhancement.
- Sandbox storage is temporary. A persistent storage layer should be added before treating this as a production multi-user service.
- Use only videos you own or are authorized to download/edit, and comply with the source platform's terms.
