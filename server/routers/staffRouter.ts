import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { companyAdminProcedure, protectedWithSubscriptionProcedure, router } from "../_core/trpc";
import * as db from "../db";

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const createStaffSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Valid email required"),
  locationId: z.number().int().optional(),
  role: z.enum(["staff", "company_admin"]).default("staff"),
});

const updateStaffSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  locationId: z.number().int().optional(),
  role: z.enum(["staff", "company_admin"]).optional(),
  status: z.enum(["active", "inactive", "suspended"]).optional(),
});

const deleteStaffSchema = z.object({
  id: z.number().int(),
});

// ============================================================================
// STAFF ROUTER
// ============================================================================

export const staffRouter = router({
  /**
   * List all staff in company
   */
  list: protectedWithSubscriptionProcedure.query(async ({ ctx }) => {
    if (!ctx.user || !ctx.user.companyId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
    }

    const staff = await db.getUsersByCompanyId(ctx.user.companyId);
    return staff.filter(u => u.role === "staff" || u.role === "company_admin");
  }),

  /**
   * Get staff member details
   */
  get: protectedWithSubscriptionProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user || !ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      const staff = await db.getUserById(input.id, ctx.user.companyId);
      if (!staff) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Staff member not found" });
      }

      return staff;
    }),

  /**
   * Create new staff member (Admin only)
   */
  create: companyAdminProcedure
    .input(createStaffSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      // Verify location belongs to company if provided
      if (input.locationId) {
        const location = await db.getLocationById(input.locationId, ctx.user.companyId);
        if (!location) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
        }
      }

      // Create user record
      // Note: In a real system, you'd generate a temporary password or invite link
      const result = await db.createUser({
        name: input.name,
        email: input.email,
        companyId: ctx.user.companyId,
        locationId: input.locationId,
        role: input.role,
        openId: `temp-${Date.now()}-${Math.random()}`, // Temporary - will be replaced on first login
        status: "active",
      });

      return {
        success: true,
        message: "Staff member created successfully",
        data: result,
      };
    }),

  /**
   * Update staff member (Admin only)
   */
  update: companyAdminProcedure
    .input(updateStaffSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      // Verify staff belongs to company
      const staff = await db.getUserById(input.id, ctx.user.companyId);
      if (!staff) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Staff member not found" });
      }

      // Verify location belongs to company if provided
      if (input.locationId) {
        const location = await db.getLocationById(input.locationId, ctx.user.companyId);
        if (!location) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
        }
      }

      // Prevent self-demotion
      if (input.id === ctx.user.id && input.role && input.role !== ctx.user.role) {
        throw new TRPCError({ 
          code: "FORBIDDEN", 
          message: "Cannot change your own role" 
        });
      }

      const updateData: Record<string, any> = {};
      if (input.name !== undefined) updateData.name = input.name;
      if (input.email !== undefined) updateData.email = input.email;
      if (input.locationId !== undefined) updateData.locationId = input.locationId;
      if (input.role !== undefined) updateData.role = input.role;
      if (input.status !== undefined) updateData.status = input.status;

      await db.updateUser(input.id, ctx.user.companyId, updateData);

      return {
        success: true,
        message: "Staff member updated successfully",
      };
    }),

  /**
   * Delete staff member (Admin only)
   */
  delete: companyAdminProcedure
    .input(deleteStaffSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      // Verify staff belongs to company
      const staff = await db.getUserById(input.id, ctx.user.companyId);
      if (!staff) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Staff member not found" });
      }

      // Prevent self-deletion
      if (input.id === ctx.user.id) {
        throw new TRPCError({ 
          code: "FORBIDDEN", 
          message: "Cannot delete yourself" 
        });
      }

      await db.deleteUser(input.id, ctx.user.companyId);

      return {
        success: true,
        message: "Staff member deleted successfully",
      };
    }),

  /**
   * Get staff statistics
   */
  stats: protectedWithSubscriptionProcedure.query(async ({ ctx }) => {
    if (!ctx.user || !ctx.user.companyId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
    }

    const staff = await db.getUsersByCompanyId(ctx.user.companyId);
    const activeStaff = staff.filter(s => s.status === "active");
    const inactiveStaff = staff.filter(s => s.status === "inactive");

    return {
      total: staff.length,
      active: activeStaff.length,
      inactive: inactiveStaff.length,
    };
  }),
});
