/// <reference types="@webgpu/types" />

// The public surface references WebGPU globals (GPU, GPUTextureFormat,
// GPUDeviceLostInfo, GPUDevice, GPUCanvasContext) that are not in the TS DOM
// lib. @webgpu/types is a runtime dependency of this package; this
// triple-slash reference (preserved by tsup's dts emitter) makes the bundled
// declarations self-contained for consumers with a plain tsconfig.

export { createRenderer, createRendererAsync, type RendererOptions } from './factory';
export { WebGL2Renderer } from './webgl2-renderer';
export { WebGPURenderer, type WebGPURendererOptions } from './webgpu-renderer';
export { Canvas2DRenderer } from './canvas2d-renderer';
export { RendererError } from './errors';
