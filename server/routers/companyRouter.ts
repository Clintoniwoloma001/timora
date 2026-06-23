import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { companyAdminProcedure, protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const createCompanySchema = z.object({
  name: z.string().min(3, "Company name must be at least 3 characters").max(255),
  email: z.string().email("Valid email required"),
  phone: z.string().optional(),
  industry: z.string().optional(),
});

const updateCompanySchema = z.object({
  id: z.number().int(),
  name: z.string().min(3).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  industry: z.string().optional(),
});

// ============================================================================
// COMPANY ROUTER
// ============================================================================

export const companyRouter = router({
  /**
   * Create a new company
   * CRITICAL: First user to create company becomes company_admin
   * Automatically sets up trial subscription
   */
  create: protectedProcedure
    .input(createCompanySchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated",
        });
      }

      // Check if user already has a company
      if (ctx.user.companyId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "User already belongs to a company. Cannot create another.",
        });
      }

      try {
        console.log(
          `[Company] Creating company "${input.name}" for user "${ctx.user.name}" (${ctx.user.openId})`
        );

        // Create company
        const companyResult = await db.createCompany({
          name: input.name,
          email: input.email,
          phone: input.phone || null,
          industry: input.industry || null,
          subscriptionStatus: "trial", // Start with trial
          plan: "free",
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 day trial
        });

        // Extract company ID from insert result (Drizzle returns insertId in metadata)
        const companyId = (companyResult as any).insertId || ctx.user.id;

        if (!companyId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create company",
          });
        }

        console.log(`[Company] Company created with ID: ${companyId}`);

        // Update user to be company_admin of this company
        await db.updateUser(ctx.user.id, ctx.user.id, {
          companyId: companyId,
          role: "company_admin", // CRITICAL: First user is admin
        });

        console.log(
          `[Company] User "${ctx.user.name}" promoted to company_admin of company ${companyId}`
        );

        // Create trial subscription
        const now = new Date();
        const trialEndDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

        await db.createSubscription({
          companyId: companyId,
          plan: "free",
          status: "active",
          startDate: now,
          endDate: trialEndDate,
          renewalDate: trialEndDate,
          amount: "0", // Free trial
          billingCycle: "monthly",
          currency: "USD",
        });

        console.log(`[Company] Trial subscription created for company ${companyId}`);

        return {
          success: true,
          message: "Company created successfully",
          data: {
            id: companyId,
            name: input.name,
            email: input.email,
            subscriptionStatus: "trial",
            trialEndsAt: trialEndDate,
          },
        };
      } catch (error: any) {
        console.error("[Company] Creation error:", error);
        throw error instanceof TRPCError
          ? error
          : new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to create company",
            });
      }
    }),

  /**
   * Get company details
   * Company admin can view their company
   */
  get: companyAdminProcedure.query(async ({ ctx }) => {
    if (!ctx.user.companyId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Company context required",
      });
    }

    const company = await db.getCompanyById(ctx.user.companyId);
    if (!company) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Company not found",
      });
    }

    return company;
  }),

  /**
   * Update company details
   * Company admin can update their company
   */
  update: companyAdminProcedure
    .input(updateCompanySchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user.companyId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Company context required",
        });
      }

      // Verify company ownership
      if (input.id !== ctx.user.companyId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot modify other companies",
        });
      }

      const company = await db.getCompanyById(input.id);
      if (!company) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Company not found",
        });
      }

      const updateData: Record<string, any> = {};
      if (input.name !== undefined) updateData.name = input.name;
      if (input.email !== undefined) updateData.email = input.email;
      if (input.phone !== undefined) updateData.phone = input.phone;
      if (input.industry !== undefined) updateData.industry = input.industry;

      await db.updateCompany(input.id, updateData);

      console.log(`[Company] Company ${input.id} updated`);

      return {
        success: true,
        message: "Company updated successfully",
      };
    }),

  /**
   * Get user's company
   * Checks if user has an associated company
   * If not, user needs to create one
   */
  getMyCompany: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user || !ctx.user.companyId) {
      console.log(
        `[Company] User "${ctx.user?.name}" has no company assigned`
      );
      return null;
    }

    const company = await db.getCompanyById(ctx.user.companyId);
    return company || null;
  }),

  /**
   * Check if user needs to complete company setup
   * Used during login to determine redirect
   */
  getSetupStatus: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not authenticated",
      });
    }

    // If user is super_admin, no company setup needed
    if (ctx.user.role === "super_admin") {
      return {
        needsSetup: false,
        reason: "super_admin",
        status: "complete",
      };
    }

    // If user doesn't have companyId, they need to create/join a company
    if (!ctx.user.companyId) {
      console.log(
        `[Company] User "${ctx.user.name}" needs to create/join company`
      );
      return {
        needsSetup: true,
        reason: "no_company",
        status: "pending",
        message: "Please create or join a company to continue",
      };
    }

    // User has a company, check subscription status
    const company = await db.getCompanyById(ctx.user.companyId);
    if (!company) {
      return {
        needsSetup: true,
        reason: "company_not_found",
        status: "error",
        message: "Company not found",
      };
    }

    // For company_admin, check subscription
    if (ctx.user.role === "company_admin") {
      return {
        needsSetup: company.subscriptionStatus === "inactive",
        reason: company.subscriptionStatus === "inactive" ? "subscription_inactive" : null,
        status: "complete",
        company,
      };
    }

    // Staff users are all set
    return {
      needsSetup: false,
      reason: "staff",
      status: "complete",
      company,
    };
  }),
});
