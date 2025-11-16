# 3D MRI Viewer

An interactive, browser-based 3D MRI segmentation viewer built with React, TensorFlow.js, and Niivue. The project enables fully client-side inference using pre-trained deep-learning models while providing manual correction tools for post-processing.

---

## Authors

- Krishnaa Nair  
- Rahul Babu  

---

## Features

- ⚡ **Real-time segmentation** powered by TensorFlow.js with optional WebWorker support.  
- 🎛️ **Clinical-style workflow** with manual drawing, undo/redo, and overlay blending.  
- 🧭 **Responsive UI** optimized for desktop and touch devices.  
- 📊 **Diagnostics snapshot** capturing GPU, browser, and memory telemetry for troubleshooting.  
- 📁 **Local-first**: drag-and-drop NIfTI volumes, download segmentation masks, and export viewer scenes.

---

## Getting Started

```bash
git clone https://github.com/tuttucodes/3d-Mri-Viewer.git
cd 3d-Mri-Viewer
npm install
npm run dev
```

Then open the printed localhost URL (defaults to `http://127.0.0.1:5173`) in a modern browser with WebGL support.

---

## Project Structure

```
├── public/                # Static assets and pretrained models
├── src/                   # React components and styling
├── inference-logic.js     # Core inference routines
├── tensor-utils.js        # Helper utilities for TensorFlow.js
├── viewer-mainthread.js   # Main-thread inference orchestrator
├── viewer-webworker.js    # WebWorker implementation
└── viewer-parameters.js   # Model catalogue and runtime options
```

---

## Available Scripts

- `npm run dev` – start the development server  
- `npm run build` – generate a production build  
- `npm run preview` – preview the production build locally  
- `npm run test` – run Playwright tests (builds first)

---

## Deployment

The project is Vite-based and ready for static hosting. To deploy to GitHub Pages:

1. Run `npm run build`.  
2. Serve the `dist` folder using your preferred hosting approach (GitHub Pages, Netlify, Vercel, etc.).  
3. Ensure the `base` value in `vite.config.js` matches your hosting path if deploying under a subdirectory.

---

## License

This project is licensed under the MIT License. See `LICENSE` for details.

---

## Acknowledgements

Inspired by the BrainChop project.

