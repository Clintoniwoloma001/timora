import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { companyAdminProcedure, protectedWithSubscriptionProcedure, router } from "../_core/trpc";
import * as db from "../db";

// ============================================================================
// DASHBOARD ROUTER
// ============================================================================

export const dashboardRouter = router({
  /**
   * Get company dashboard overview (Admin only)
   */
  overview: companyAdminProcedure.query(async ({ ctx }) => {
    if (!ctx.user.companyId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
    }

    // Get company info
    const company = await db.getCompanyById(ctx.user.companyId);
    if (!company) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Company not found" });
    }

    // Get stats
    const stats = await db.getCompanyStats(ctx.user.companyId);

    // Get subscription info
    const subscription = await db.getSubscriptionByCompanyId(ctx.user.companyId);

    // Get today's attendance
    const allAttendance = await db.getAttendanceByCompanyId(ctx.user.companyId, 1000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayAttendance = allAttendance.filter(log => {
      const logDate = new Date(log.clockInTime);
      logDate.setHours(0, 0, 0, 0);
      return logDate.getTime() === today.getTime();
    });

    // Get recent reports
    const reports = await db.getReportsByCompanyId(ctx.user.companyId, 10);
    const pendingReports = reports.filter(r => r.status === "submitted");

    return {
      company: {
        id: company.id,
        name: company.name,
        email: company.email,
        plan: company.plan,
        subscriptionStatus: company.subscriptionStatus,
      },
      stats: {
        totalStaff: stats?.totalStaff || 0,
        activeStaff: stats?.totalStaff || 0, // Can be enhanced
        todayCheckIns: todayAttendance.length,
        pendingReports: pendingReports.length,
      },
      subscription: subscription ? {
        plan: subscription.plan,
        status: subscription.status,
        renewalDate: subscription.renewalDate,
      } : null,
      recentReports: reports.slice(0, 5),
      recentAttendance: todayAttendance.slice(0, 10),
    };
  }),

  /**
   * Get staff performance metrics (Admin only)
   */
  staffPerformance: companyAdminProcedure.query(async ({ ctx }) => {
    if (!ctx.user.companyId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
    }

    const staff = await db.getUsersByCompanyId(ctx.user.companyId);
    const attendance = await db.getAttendanceByCompanyId(ctx.user.companyId, 10000);

    const performance = staff
      .filter(s => s.role === "staff")
      .map(s => {
        const staffAttendance = attendance.filter(a => a.userId === s.id);
        const completedDays = staffAttendance.filter(a => a.clockOutTime).length;
        const totalHours = staffAttendance.reduce((sum, a) => sum + (parseFloat(a.totalHours as any) || 0), 0);
        const avgHours = completedDays > 0 ? (totalHours / completedDays).toFixed(2) : 0;

        return {
          id: s.id,
          name: s.name,
          email: s.email,
          totalDaysWorked: completedDays,
          totalHours: totalHours.toFixed(2),
          averageHoursPerDay: avgHours,
          status: s.status,
        };
      });

    return performance;
  }),

  /**
   * Get attendance analytics (Admin only)
   */
  attendanceAnalytics: companyAdminProcedure.query(async ({ ctx }) => {
    if (!ctx.user.companyId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
    }

    const attendance = await db.getAttendanceByCompanyId(ctx.user.companyId, 10000);
    
    // Group by date
    const byDate: Record<string, any> = {};
    attendance.forEach(record => {
      const date = new Date(record.clockInTime).toISOString().split('T')[0];
      if (!byDate[date]) {
        byDate[date] = { checkIns: 0, avgHours: 0, totalHours: 0, count: 0 };
      }
      byDate[date].checkIns++;
      if (record.totalHours) {
        byDate[date].totalHours += parseFloat(record.totalHours as any);
        byDate[date].count++;
      }
    });

    // Calculate averages
    const analytics = Object.entries(byDate).map(([date, data]) => ({
      date,
      checkIns: data.checkIns,
      averageHours: data.count > 0 ? (data.totalHours / data.count).toFixed(2) : 0,
      totalHours: data.totalHours.toFixed(2),
    }));

    return analytics.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }),

  /**
   * Get reports summary (Admin only)
   */
  reportsSummary: companyAdminProcedure.query(async ({ ctx }) => {
    if (!ctx.user.companyId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
    }

    const reports = await db.getReportsByCompanyId(ctx.user.companyId, 10000);
    const staff = await db.getUsersByCompanyId(ctx.user.companyId);

    // Group by user
    const byUser: Record<number, any> = {};
    staff.filter(s => s.role === "staff").forEach(s => {
      byUser[s.id] = {
        name: s.name,
        email: s.email,
        submitted: 0,
        reviewed: 0,
        approved: 0,
        draft: 0,
      };
    });

    reports.forEach(report => {
      if (byUser[report.userId]) {
        byUser[report.userId][report.status]++;
      }
    });

    const summary = Object.values(byUser).map((user: any) => ({
      ...user,
      total: user.submitted + user.reviewed + user.approved + user.draft,
      submissionRate: user.total > 0 ? ((user.submitted + user.reviewed + user.approved) / user.total * 100).toFixed(1) : 0,
    }));

    return {
      totalReports: reports.length,
      submitted: reports.filter(r => r.status === "submitted").length,
      reviewed: reports.filter(r => r.status === "reviewed").length,
      approved: reports.filter(r => r.status === "approved").length,
      draft: reports.filter(r => r.status === "draft").length,
      byStaff: summary,
    };
  }),

  /**
   * Get staff dashboard summary (Staff only)
   */
  staffSummary: protectedWithSubscriptionProcedure.query(async ({ ctx }) => {
    if (!ctx.user || !ctx.user.companyId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
    }

    // Today's attendance
    const today = new Date();
    const todayAttendance = await db.getAttendanceByUserAndDate(
      ctx.user.id,
      ctx.user.companyId,
      today
    );

    // Recent attendance
    const recentAttendance = await db.getAttendanceByUserId(ctx.user.id, ctx.user.companyId, 7);

    // My reports
    const myReports = await db.getReportsByUserId(ctx.user.id, ctx.user.companyId, 10);

    // Calculate stats
    const totalHoursThisWeek = recentAttendance
      .filter(a => a.totalHours)
      .reduce((sum, a) => sum + parseFloat(a.totalHours as any), 0)
      .toFixed(2);

    const daysWorkedThisWeek = recentAttendance.filter(a => a.clockOutTime).length;

    return {
      todayStatus: todayAttendance ? {
        clockedIn: !todayAttendance.clockOutTime,
        clockInTime: todayAttendance.clockInTime,
        clockOutTime: todayAttendance.clockOutTime,
        totalHours: todayAttendance.totalHours,
      } : {
        clockedIn: false,
        clockInTime: null,
        clockOutTime: null,
        totalHours: null,
      },
      weekStats: {
        daysWorked: daysWorkedThisWeek,
        totalHours: totalHoursThisWeek,
        averageHours: daysWorkedThisWeek > 0 ? (parseFloat(totalHoursThisWeek as string) / daysWorkedThisWeek).toFixed(2) : 0,
      },
      recentAttendance: recentAttendance.slice(0, 5),
      recentReports: myReports.slice(0, 5),
      pendingReports: myReports.filter(r => r.status === "draft").length,
    };
  }),
});
