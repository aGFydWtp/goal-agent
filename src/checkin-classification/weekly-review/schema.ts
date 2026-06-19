import { z } from "zod";

export const weeklyReviewSchema = z.object({
  summary: z.string().min(1),
  risks: z.array(z.string().min(1)),
  next_actions: z.array(z.string().min(1)),
});

export type WeeklyReview = z.infer<typeof weeklyReviewSchema>;
