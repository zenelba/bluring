# Bluring

A simple web app to blur brand logotypes in images. Upload an image, draw rectangles over logos, adjust the blur level, and download the result.

## Features

- **Image upload** — drag & drop or click to select (PNG, JPG, WebP)
- **Region selection** — draw rectangles over brand logos to blur
- **Adjustable blur** — slider from 1px to 50px
- **Live preview** — see the blur applied in real time
- **Download** — export the processed image as PNG

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## Usage

1. Upload an image containing brand logotypes
2. Click and drag on the image to draw a box around each logo
3. Use the blur intensity slider to set how strong the blur should be
4. Click **Download result** to save the processed image

## Build

```bash
npm run build
npm run preview
```
