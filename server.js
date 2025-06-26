const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { execSync, exec, spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const util = require('util');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { Server } = require('socket.io');

const app = express();
const port = 3000;

const io = new Server(3001, { cors: { origin: '*' } });
const clients = new Map();
io.on('connection', (socket) => {
  const projectId = socket.handshake.query.projectId;
  if (!projectId) return socket.disconnect();
  if (!clients.has(projectId)) clients.set(projectId, new Set());
  clients.get(projectId).add(socket);
  socket.on('disconnect', () => {
    clients.get(projectId).delete(socket);
    if (clients.get(projectId).size === 0) clients.delete(projectId);
  });
});

function broadcastLog(projectId, log) {
  const clientSet = clients.get(projectId);
  if (clientSet) {
    clientSet.forEach(client => client.emit('log', log));
  }
}

const TEMP_DIR = path.join(__dirname, 'temp');
const PREVIEW_DIR = path.join(__dirname, 'public', 'previews');
const PUBSPEC_YAML = `
name: flutter_preview
description: A temporary Flutter project for preview.
version: 1.0.0
environment:
  sdk: '>=2.12.0 <3.0.0'
dependencies:
  flutter:
    sdk: flutter
flutter:
  uses-material-design: true
`;

const backendContainers = {};
let nextPort = 35001;

async function ensureDirs() {
  await fs.mkdir(TEMP_DIR, { recursive: true });
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
}
ensureDirs();

async function printDir(projectDir) {
  try {
    const { stdout, stderr } = await util.promisify(exec)(`ls -laR ${projectDir}`);
    console.log('TEMP PROJECT DIR CONTENTS:\n', stdout);
    if (stderr) console.error(stderr);
  } catch (e) {
    console.error('Failed to list dir:', e);
  }
}

app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

app.post('/compile', async (req, res) => {
    console.log('Received request body:', req.body);
    const { projectName, files } = req.body;

    if (!projectName || !files || typeof files !== 'object') {
        return res.status(400).json({ error: 'Invalid or missing project data' });
    }

    const projectId = uuidv4();
    const projectDir = path.resolve(TEMP_DIR, projectId);
    const previewDir = path.join(PREVIEW_DIR, projectId);

    try {
        await fs.mkdir(projectDir, { recursive: true });
        await fs.chmod(projectDir, 0o775); // Ensure directory permissions

        for (const [filePath, content] of Object.entries(files)) {
            const relativePath = filePath.replace(/^\/+/, '');
            const fullPath = path.join(projectDir, relativePath);
            console.log(`Writing file: ${fullPath}`);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, content);
            await fs.chmod(fullPath, 0o664);
            try {
                await fs.access(fullPath, fs.constants.F_OK);
                console.log(`File verified: ${fullPath}`);
            } catch (e) {
                throw new Error(`Failed to verify file: ${fullPath}`);
            }
        }

        const pubspecPath = path.join(projectDir, 'pubspec.yaml');
        if (!files['/pubspec.yaml']) {
            await fs.writeFile(pubspecPath, PUBSPEC_YAML.trim());
            await fs.chmod(pubspecPath, 0o664);
            await fs.access(pubspecPath, fs.constants.F_OK);
            console.log(`Pubspec written and verified: ${pubspecPath}`);
        }

        const webDir = path.join(projectDir, 'web');
        await fs.mkdir(webDir, { recursive: true });
        await fs.chmod(webDir, 0o775);
        const indexHtmlPath = path.join(webDir, 'index.html');
        const DEFAULT_INDEX_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Flutter Web</title>
  <meta name="description" content="A new Flutter project.">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="manifest" href="manifest.json">
</head>
<body>
  <script src="main.dart.js"></script>
</body>
</html>`;
        try {
            await fs.access(indexHtmlPath, fs.constants.F_OK);
            console.log(`Index.html exists: ${indexHtmlPath}`);
        } catch (e) {
            await fs.writeFile(indexHtmlPath, DEFAULT_INDEX_HTML);
            await fs.chmod(indexHtmlPath, 0o664);
            await fs.access(indexHtmlPath, fs.constants.F_OK);
            console.log(`Index.html written and verified: ${indexHtmlPath}`);
        }

        await printDir(projectDir);

        const dockerCommand = [
            'run',
            '--rm',
            '-v',
            `${projectDir}:/app`,
            'flutter-preview'
        ];
        console.log('Executing Docker command:', `docker ${dockerCommand.join(' ')}`);
        const dockerProcess = spawn('docker', dockerCommand);

        let dockerError = '';
        dockerProcess.stdout.on('data', (data) => {
            const message = data.toString().trim();
            if (message) {
                console.log('Docker stdout:', message);
                broadcastLog(projectId, {
                    type: 'log',
                    message,
                    timestamp: new Date().toLocaleTimeString()
                });
            }
        });

        dockerProcess.stderr.on('data', (data) => {
            const message = data.toString().trim();
            if (message) {
                dockerError += message + '\n';
                console.error('Docker stderr:', message);
                broadcastLog(projectId, {
                    type: 'error',
                    message,
                    timestamp: new Date().toLocaleTimeString()
                });
            }
        });

        dockerProcess.on('close', async (code) => {
            if (code !== 0) {
                const errorMessage = `Docker process exited with code ${code}`;
                console.error('Docker error:', dockerError);
                broadcastLog(projectId, {
                    type: 'error',
                    message: errorMessage,
                    timestamp: new Date().toLocaleTimeString()
                });
                return res.status(500).json({ error: 'Failed to compile Flutter code', details: dockerError || errorMessage });
            }

            try {
                await fs.rename(path.join(projectDir, 'build', 'web'), previewDir);
                await fs.rm(projectDir, { recursive: true, force: true });

                setTimeout(async () => {
                    try {
                        await fs.rm(previewDir, { recursive: true, force: true });
                        console.log(`Cleaned up preview: ${previewDir}`);
                    } catch (err) {
                        console.error(`Error cleaning up ${previewDir}:`, err);
                    }
                }, 3600000);

                const previewUrl = `http://localhost:${port}/previews/${projectId}/index.html`;
                res.json({ previewUrl });
            } catch (err) {
                console.error('Post-compilation error:', err, err.stack);
                await fs.rm(projectDir, { recursive: true, force: true }).catch(e => console.error('Cleanup failed:', e));
                await fs.rm(previewDir, { recursive: true, force: true }).catch(e => console.error('Cleanup failed:', e));
                res.status(500).json({ error: 'Failed to process compiled output', details: err.message });
            }
        });
    } catch (err) {
        console.error('Compilation error:', err, err.stack);
        const errorMessage = err.message || 'Unknown error';
        await fs.rm(projectDir, { recursive: true, force: true }).catch(e => console.error('Cleanup failed:', e));
        await fs.rm(previewDir, { recursive: true, force: true }).catch(e => console.error('Cleanup failed:', e));
        res.status(500).json({ error: 'Failed to compile Flutter code', details: errorMessage });
    }
});

app.post('/compile-backend', async (req, res) => {
  const { projectName, files } = req.body;
  if (!projectName || !files || typeof files !== 'object') {
    return res.status(400).json({ error: 'Invalid or missing project data' });
  }

  const projectId = uuidv4();
  const projectDir = path.join(TEMP_DIR, projectId);
  const portToUse = nextPort++;
  const containerName = `backend-${projectId}`;

  try {
    await fs.mkdir(projectDir, { recursive: true });

    for (const [filePath, content] of Object.entries(files)) {
      const relativePath = filePath.replace(/^\/+/, '');
      const fullPath = path.join(projectDir, relativePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }

    execSync(`docker build -f dockerfile.backend -t ${containerName} ${projectDir}`, { stdio: 'inherit' });

    execSync(
      `docker run -d --rm --name ${containerName} -p ${portToUse}:3000 ${containerName}`,
      { stdio: 'inherit' }
    );

    const logProcess = spawn('docker', ['logs', '-f', containerName]);

    logProcess.stdout.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        broadcastLog(projectId, {
          type: 'log',
          message,
          timestamp: new Date().toLocaleTimeString()
        });
      }
    });

    logProcess.stderr.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        broadcastLog(projectId, {
          type: 'error',
          message,
          timestamp: new Date().toLocaleTimeString()
        });
      }
    });

    const timer = setTimeout(() => {
      try {
        execSync(`docker stop ${containerName}`);
        console.log(`Stopped backend container: ${containerName}`);
      } catch (err) {
        console.error(`Error stopping backend container: ${containerName}`, err);
      }
    }, 3600000);

    backendContainers[projectId] = { port: portToUse, containerName, timer };

    const apiUrl = `/previews/backend/${projectId}/api`;
    res.json({ apiUrl });
  } catch (err) {
    console.error('Backend compilation error:', err);
    await fs.rm(projectDir, { recursive: true, force: true }).catch(e => console.error('Cleanup failed:', e));
    try {
      execSync(`docker stop ${containerName}`, { stdio: 'ignore' });
      execSync(`pkill -f "docker logs -f ${containerName}"`, { stdio: 'ignore' });
    } catch (e) {
      console.error('Container cleanup failed:', e);
    }
    res.status(500).json({ error: 'Failed to build or run backend code', details: err.message });
  }
});

app.use('/previews/backend/:projectId/api', (req, res, next) => {
  const projectId = req.params.projectId;
  const info = backendContainers[projectId];
  if (!info) return res.status(404).send('Backend not running for this project');

  const prefix = `/previews/backend/${projectId}/api`;
  const restOfPath = req.originalUrl.startsWith(prefix) ? req.originalUrl.slice(prefix.length) : '';
  const targetPath = '/api' + restOfPath;

  console.log(`[PROXY] ${req.originalUrl} → ${targetPath} (to ${info.port})`);

  return createProxyMiddleware({
    target: `http://localhost:${info.port}`,
    pathRewrite: () => targetPath,
    changeOrigin: true,
    logLevel: 'debug'
  })(req, res, next);
});

process.on('SIGINT', () => {
  console.log('Cleaning up backend containers...');
  for (const projectId in backendContainers) {
    const { containerName, timer } = backendContainers[projectId];
    clearTimeout(timer);
    try {
      execSync(`docker stop ${containerName}`, { stdio: 'ignore' });
      execSync(`pkill -f "docker logs -f ${containerName}"`, { stdio: 'ignore' });
      console.log(`Stopped container: ${containerName}`);
    } catch (e) {
      console.error(`Failed to clean up container ${containerName}:`, e);
    }
  }
  process.exit();
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${port}`);
});