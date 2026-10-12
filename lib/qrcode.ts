import QRCode from 'qrcode';
import { ValidationError } from '@/lib/errors';

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export interface QrSvgOptions {
  /** 每个模块的边长（px） */
  size?: number;
  /** 静区宽度（模块数） */
  margin?: number;
  /** 纠错等级，默认 Q —— 屏幕反光 / 拍摄时更耐得住 */
  errorCorrectionLevel?: QrErrorCorrection;
  /** 前景色，必须是 #rgb / #rrggbb / #rrggbbaa */
  dark?: string;
  /** 背景色，必须是 #rgb / #rrggbb / #rrggbbaa */
  light?: string;
}

/** 超过这个长度直接拒绝，避免把整个存储塞进一张图 */
const MAX_TEXT_LENGTH = 2048;
const MIN_SIZE = 64;
const MAX_SIZE = 1024;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * 颜色会被拼进 SVG 属性，只放行十六进制写法，
 * 免得有人拿 `data=` 接口当注入点用。
 */
function sanitizeColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  return HEX_COLOR.test(trimmed) ? trimmed : fallback;
}

/**
 * 把任意文本渲染成 SVG 二维码。
 * 输出是矢量图，手机放大 / 缩小都能扫，不会有位图放大的糊边。
 */
export async function renderQrSvg(text: string, options: QrSvgOptions = {}): Promise<string> {
  const content = typeof text === 'string' ? text.trim() : '';
  if (!content) {
    throw new ValidationError('二维码内容不能为空');
  }
  if (content.length > MAX_TEXT_LENGTH) {
    throw new ValidationError(`二维码内容过长（最多 ${MAX_TEXT_LENGTH} 字符，当前 ${content.length}）`);
  }

  const size = clampInt(options.size, MIN_SIZE, MAX_SIZE, 256);
  const margin = clampInt(options.margin, 0, 8, 2);
  const errorCorrectionLevel = options.errorCorrectionLevel ?? 'Q';

  return QRCode.toString(content, {
    type: 'svg',
    errorCorrectionLevel,
    margin,
    scale: 4,
    color: {
      dark: sanitizeColor(options.dark, '#09090bff'),
      light: sanitizeColor(options.light, '#ffffffff'),
    },
  }).then((svg) => rewriteSvgSize(svg, size));
}

/**
 * qrcode 生成的 SVG 用 viewBox + width/height，按目标尺寸重写一次，
 * 保证直接塞进 <img> 时有确定的像素尺寸（否则部分浏览器会按 0 宽渲染）。
 */
function rewriteSvgSize(svg: string, size: number): string {
  return svg
    .replace(/<svg([^>]*)>/, (_match, attrs: string) => {
      const cleaned = attrs
        .replace(/\s*width="[^"]*"/, '')
        .replace(/\s*height="[^"]*"/, '')
        .replace(/\s*style="[^"]*"/, '');
      return `<svg${cleaned} width="${size}" height="${size}" style="width:${size}px;height:${size}px">`;
    });
}
