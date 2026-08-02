import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const designTokens = {
  colors: {
    brand: {
      primary: "#1E90FF",
      deep:    "#0047AB",
      navy:    "#001F5B",
    },
    accent: {
      cyan:    "#00D4FF",
      violet:  "#7B6EF6",
      emerald: "#00E5A0",
      rose:    "#FF4066",
    },
  },
  animation: {
    duration: {
      fast:      150,
      normal:    300,
      slow:      500,
      cinematic: 800,
    },
    easing: {
      expoOut:   [0.16, 1, 0.3, 1] as const,
      expoIn:    [0.7, 0, 0.84, 0] as const,
      spring:    [0.34, 1.56, 0.64, 1] as const,
    },
  },
} as const;

export type Environment = "sandbox" | "production";
