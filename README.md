# AI Clip Studio

Private, free-first YouTube clipping workflow for videos you own or are authorized to process.

## Live site

**https://clipping-beryl.vercel.app/**

## Stack

- Vercel: frontend + API launcher
- Vercel Sandbox: background video processing
- Vercel AI Gateway: default AI provider with OIDC on Vercel
- Groq / Gemini: optional direct-provider fallbacks
- OpenAI: optional paid fallback, disabled by default
- FFmpeg + yt-dlp + Deno + yt-dlp EJS: video/audio processing

## Environment variables

AI provider order:
```
AI_PROVIDER_ORDER=gateway,groq,gemini,openai
ALLOW_PAID_FALLBACK=false
PAID_FALLBACK_MAX_USD=0
```

For YouTube videos that require an authenticated request, configure one of these **server-side Vercel secrets**:

```
YOUTUBE_COOKIES_B64=
YOUTUBE_COOKIES=
YOUTUBE_USER_AGENT=
```

`YOUTUBE_COOKIES_B64` is preferred. It should contain a base64-encoded Netscape-format cookie file exported from the account that is authorized to access the video. The worker writes the secret to a temporary 0600 cookie file, uses it only for yt-dlp, and deletes it after the download attempt.

Never commit real cookies, API keys, or session credentials to GitHub. Never paste cookies into chat. Treat exported cookies like passwords.

## Deploy

1. Import this repository into your Vercel account.
2. Add the AI provider environment variables in Vercel.
3. When needed, add the YouTube authentication secrets above in Vercel.
4. Deploy.
5. Open the deployed site and paste a YouTube URL you own or are authorized to process.

## Processing flow

YouTube URL -> sandbox worker -> optional authorized cookie jar -> video download -> audio extraction -> timestamped transcription -> AI ranking -> up to 50 distinct clips -> 9:16 FFmpeg rendering -> downloadable MP4s.

The downloader does not attempt to bypass YouTube bot verification, CAPTCHA, or other access controls. When YouTube requires authentication, the workflow uses only credentials explicitly supplied by the authorized account owner.

## Important limitations

- Free API quotas are limited; they are not unlimited.
- The current renderer uses a centered vertical crop. Intelligent face/speaker tracking is a future enhancement.
- Sandbox storage is temporary. A persistent storage layer should be added before treating this as a production multi-user service.
- Some YouTube authentication can depend on the originating session/network, so a cloud worker may still be unable to fetch certain videos even with valid cookies. A direct authorized video upload is the most reliable fallback.
- Use only videos you own or are authorized to download/edit, and comply with the source platform's terms.

## YouTube bot-verification fallback

The app now has two supported source paths:

1. Authorized YouTube URL: uses the YouTube downloader with Deno/EJS and optional authorized cookies. It does not bypass CAPTCHA or bot verification.
2. Direct video upload: when YouTube rejects the server, the browser uploads the source directly to Vercel Blob and the worker processes the uploaded file.

For direct uploads, create a Vercel Blob store connected to this project. Vercel documents client uploads for files larger than the 4.5 MB Vercel Function request limit, and the Hobby plan includes 1 GB Blob storage plus included operations/data transfer within its limits.

The direct-upload path accepts video files up to 900 MB and deletes the temporary Blob source after processing.

