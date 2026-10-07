const { handleUpload } = require('@vercel/blob/client');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({
      error: 'Vercel Blob is not configured. Create a Blob store for this project and enable the BLOB_READ_WRITE_TOKEN environment variable.'
    });
  }

  let body = req.body;
  try {
    if (typeof body === 'string') body = JSON.parse(body);
  } catch {
    return res.status(400).json({ error: 'Invalid upload request.' });
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        const cleanName = String(pathname || '').toLowerCase();
        if (!/^sources\\//.test(cleanName)) {
          throw new Error('Invalid upload path.');
        }

        return {
          allowedContentTypes: [
            'video/mp4',
            'video/webm',
            'video/quicktime',
            'video/x-matroska',
            'video/mpeg',
            'video/x-msvideo'
          ],
          addRandomSuffix: true,
          maximumSizeInBytes: 900 * 1024 * 1024,
          tokenPayload: JSON.stringify({ purpose: 'clip-source' })
        };
      },
      onUploadCompleted: async () => {
        // Processing is started explicitly by /api/analyze after the browser
        // has received the completed Blob URL.
      }
    });

    return res.status(200).json(jsonResponse);
  } catch (error) {
    return res.status(400).json({
      error: error?.message || 'Could not prepare the upload.'
    });
  }
};

module.exports.maxDuration = 30;
