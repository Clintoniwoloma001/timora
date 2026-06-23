import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedWithSubscriptionProcedure, companyAdminProcedure, router } from "../_core/trpc";
import * as db from "../db";

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const clockInSchema = z.object({
  locationId: z.number().int().optional(),
  gpsLat: z.number().optional(),
  gpsLng: z.number().optional(),
});

const clockOutSchema = z.object({
  gpsLat: z.number().optional(),
  gpsLng: z.number().optional(),
});

// ============================================================================
// ATTENDANCE ROUTER
// ============================================================================

export const attendanceRouter = router({
  /**
   * Clock in for the day
   */
  clockIn: protectedWithSubscriptionProcedure
    .input(clockInSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user || !ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      if (ctx.user.role === "company_admin") {
        throw new TRPCError({ 
          code: "FORBIDDEN", 
          message: "Only staff can clock in" 
        });
      }

      // Check if already clocked in today
      const today = new Date();
      const existingAttendance = await db.getAttendanceByUserAndDate(
        ctx.user.id,
        ctx.user.companyId,
        today
      );

      if (existingAttendance && !existingAttendance.clockOutTime) {
        throw new TRPCError({ 
          code: "CONFLICT", 
          message: "You are already clocked in" 
        });
      }

      // Create attendance record
      const result = await db.createAttendance({
        companyId: ctx.user.companyId,
        userId: ctx.user.id,
        locationId: input.locationId || ctx.user.locationId,
        clockInTime: new Date(),
        clockInGpsLat: input.gpsLat,
        clockInGpsLng: input.gpsLng,
        status: "active",
      });

      return {
        success: true,
        message: "Clocked in successfully",
        data: result,
      };
    }),

  /**
   * Clock out for the day
   */
  clockOut: protectedWithSubscriptionProcedure
    .input(clockOutSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user || !ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      if (ctx.user.role === "company_admin") {
        throw new TRPCError({ 
          code: "FORBIDDEN", 
          message: "Only staff can clock out" 
        });
      }

      // Get today's attendance
      const today = new Date();
      const attendance = await db.getAttendanceByUserAndDate(
        ctx.user.id,
        ctx.user.companyId,
        today
      );

      if (!attendance) {
        throw new TRPCError({ 
          code: "NOT_FOUND", 
          message: "No active clock-in found" 
        });
      }

      if (attendance.clockOutTime) {
        throw new TRPCError({ 
          code: "CONFLICT", 
          message: "You have already clocked out" 
        });
      }

      // Calculate total hours
      const clockOutTime = new Date();
      const clockInTime = new Date(attendance.clockInTime);
      const totalMs = clockOutTime.getTime() - clockInTime.getTime();
      const totalHours = (totalMs / (1000 * 60 * 60)).toFixed(2);

      // Update attendance record
      await db.updateAttendance(attendance.id, ctx.user.companyId, {
        clockOutTime,
        clockOutGpsLat: input.gpsLat,
        clockOutGpsLng: input.gpsLng,
        totalHours: totalHours,
        status: "completed",
      });

      return {
        success: true,
        message: `Clocked out successfully. Total hours: ${totalHours}`,
        data: {
          totalHours: parseFloat(totalHours),
        },
      };
    }),

  /**
   * Get today's attendance status
   */
  todayStatus: protectedWithSubscriptionProcedure.query(async ({ ctx }) => {
    if (!ctx.user || !ctx.user.companyId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
    }

    const today = new Date();
    const attendance = await db.getAttendanceByUserAndDate(
      ctx.user.id,
      ctx.user.companyId,
      today
    );

    if (!attendance) {
      return {
        status: "not_clocked_in",
        clockInTime: null,
        clockOutTime: null,
        totalHours: null,
      };
    }

    return {
      status: attendance.clockOutTime ? "clocked_out" : "clocked_in",
      clockInTime: attendance.clockInTime,
      clockOutTime: attendance.clockOutTime,
      totalHours: attendance.totalHours,
    };
  }),

  /**
   * Get user's attendance history
   */
  history: protectedWithSubscriptionProcedure
    .input(z.object({ limit: z.number().int().default(30) }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user || !ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      return db.getAttendanceByUserId(ctx.user.id, ctx.user.companyId, input.limit);
    }),

  /**
   * Get company attendance logs (Admin only)
   */
  companyLogs: companyAdminProcedure
    .input(z.object({ limit: z.number().int().default(100) }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      return db.getAttendanceByCompanyId(ctx.user.companyId, input.limit);
    }),

  /**
   * Get attendance statistics for company (Admin only)
   */
  stats: companyAdminProcedure.query(async ({ ctx }) => {
    if (!ctx.user.companyId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
    }

    const logs = await db.getAttendanceByCompanyId(ctx.user.companyId, 1000);
    
    // Today's stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayLogs = logs.filter(log => {
      const logDate = new Date(log.clockInTime);
      logDate.setHours(0, 0, 0, 0);
      return logDate.getTime() === today.getTime();
    });

    // Average hours
    const completedLogs = logs.filter(log => log.totalHours);
    const avgHours = completedLogs.length > 0
      ? (completedLogs.reduce((sum, log) => sum + parseFloat(log.totalHours as any), 0) / completedLogs.length).toFixed(2)
      : 0;

    return {
      todayCheckIns: todayLogs.length,
      totalRecords: logs.length,
      averageHoursWorked: avgHours,
    };
  }),
});
