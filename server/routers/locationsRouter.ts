import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { companyAdminProcedure, protectedWithSubscriptionProcedure, router } from "../_core/trpc";
import * as db from "../db";

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const createLocationSchema = z.object({
  name: z.string().min(1, "Name is required"),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  timezone: z.string().default("UTC"),
});

const updateLocationSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1).optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  timezone: z.string().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

// ============================================================================
// LOCATIONS ROUTER
// ============================================================================

export const locationsRouter = router({
  /**
   * List all locations for company
   */
  list: protectedWithSubscriptionProcedure.query(async ({ ctx }) => {
    if (!ctx.user || !ctx.user.companyId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
    }

    return db.getLocationsByCompanyId(ctx.user.companyId);
  }),

  /**
   * Get location details
   */
  get: protectedWithSubscriptionProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user || !ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      const location = await db.getLocationById(input.id, ctx.user.companyId);
      if (!location) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
      }

      return location;
    }),

  /**
   * Create new location (Admin only)
   */
  create: companyAdminProcedure
    .input(createLocationSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      const result = await db.createLocation({
        companyId: ctx.user.companyId,
        name: input.name,
        address: input.address,
        city: input.city,
        state: input.state,
        country: input.country,
        latitude: input.latitude,
        longitude: input.longitude,
        timezone: input.timezone,
        status: "active",
      });

      return {
        success: true,
        message: "Location created successfully",
        data: result,
      };
    }),

  /**
   * Update location (Admin only)
   */
  update: companyAdminProcedure
    .input(updateLocationSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      const location = await db.getLocationById(input.id, ctx.user.companyId);
      if (!location) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
      }

      const updateData: Record<string, any> = {};
      if (input.name !== undefined) updateData.name = input.name;
      if (input.address !== undefined) updateData.address = input.address;
      if (input.city !== undefined) updateData.city = input.city;
      if (input.state !== undefined) updateData.state = input.state;
      if (input.country !== undefined) updateData.country = input.country;
      if (input.latitude !== undefined) updateData.latitude = input.latitude;
      if (input.longitude !== undefined) updateData.longitude = input.longitude;
      if (input.timezone !== undefined) updateData.timezone = input.timezone;
      if (input.status !== undefined) updateData.status = input.status;

      await db.updateLocation(input.id, ctx.user.companyId, updateData);

      return {
        success: true,
        message: "Location updated successfully",
      };
    }),

  /**
   * Delete location (Admin only)
   */
  delete: companyAdminProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      const location = await db.getLocationById(input.id, ctx.user.companyId);
      if (!location) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
      }

      // Check if any staff are assigned to this location
      const staff = await db.getUsersByCompanyId(ctx.user.companyId);
      const assignedStaff = staff.filter(s => s.locationId === input.id);

      if (assignedStaff.length > 0) {
        throw new TRPCError({ 
          code: "CONFLICT", 
          message: `Cannot delete location with ${assignedStaff.length} assigned staff` 
        });
      }

      await db.deleteLocation(input.id, ctx.user.companyId);

      return {
        success: true,
        message: "Location deleted successfully",
      };
    }),
});
