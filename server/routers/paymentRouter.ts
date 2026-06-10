import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { companyAdminProcedure, protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import axios from "axios";

// ============================================================================
// PAYSTACK CONFIGURATION
// ============================================================================

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY;
const PAYSTACK_API_URL = "https://api.paystack.co";

if (!PAYSTACK_SECRET_KEY) {
  console.warn("[Payment] PAYSTACK_SECRET_KEY not configured");
}

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const initiatePaymentSchema = z.object({
  planType: z.enum(["starter", "professional", "enterprise"]),
  email: z.string().email(),
  amount: z.number().min(100), // Amount in cents
});

const verifyPaymentSchema = z.object({
  reference: z.string().min(1),
});

// ============================================================================
// PAYMENT PLANS
// ============================================================================

const PAYMENT_PLANS = {
  starter: {
    name: "Starter Plan",
    amount: 2900, // $29 in cents
    monthlyAmount: 2900,
    description: "Up to 50 staff, 1 location, Basic attendance tracking",
  },
  professional: {
    name: "Professional Plan",
    amount: 7900, // $79 in cents
    monthlyAmount: 7900,
    description: "Up to 500 staff, Unlimited locations, GPS tracking, Advanced analytics",
  },
  enterprise: {
    name: "Enterprise Plan",
    amount: 29900, // $299 in cents (custom pricing)
    monthlyAmount: 29900,
    description: "Unlimited staff, Custom features, Dedicated support",
  },
};

// ============================================================================
// PAYMENT ROUTER
// ============================================================================

export const paymentRouter = router({
  /**
   * Initiate Paystack payment
   * Allows company admins to start payment process
   */
  initiatePayment: companyAdminProcedure
    .input(initiatePaymentSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user.companyId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Company context required",
        });
      }

      if (!PAYSTACK_SECRET_KEY) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Payment service not configured",
        });
      }

      try {
        const plan = PAYMENT_PLANS[input.planType];
        if (!plan) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid plan type",
          });
        }

        // Initialize payment with Paystack
        const response = await axios.post(
          `${PAYSTACK_API_URL}/transaction/initialize`,
          {
            email: input.email,
            amount: input.amount,
            metadata: {
              companyId: ctx.user.companyId,
              userId: ctx.user.id,
              planType: input.planType,
              planName: plan.name,
            },
            plan: input.planType, // Create/use Paystack plan
          },
          {
            headers: {
              Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (!response.data.status) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to initialize payment",
          });
        }

        return {
          success: true,
          data: {
            authorizationUrl: response.data.data.authorization_url,
            accessCode: response.data.data.access_code,
            reference: response.data.data.reference,
          },
        };
      } catch (error: any) {
        console.error("[Payment] Paystack initialization error:", error.response?.data || error.message);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.response?.data?.message || "Failed to initiate payment",
        });
      }
    }),

  /**
   * Verify Paystack payment
   * Called after user completes payment
   */
  verifyPayment: companyAdminProcedure
    .input(verifyPaymentSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user.companyId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Company context required",
        });
      }

      if (!PAYSTACK_SECRET_KEY) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Payment service not configured",
        });
      }

      try {
        // Verify payment with Paystack
        const response = await axios.get(
          `${PAYSTACK_API_URL}/transaction/verify/${input.reference}`,
          {
            headers: {
              Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            },
          }
        );

        if (!response.data.status) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Payment verification failed",
          });
        }

        const paymentData = response.data.data;

        // Verify metadata matches
        if (paymentData.metadata.companyId !== ctx.user.companyId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Payment does not belong to this company",
          });
        }

        if (paymentData.status !== "success") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Payment was not successful",
          });
        }

        // Get plan details
        const planType = paymentData.metadata.planType;
        const plan = PAYMENT_PLANS[planType as keyof typeof PAYMENT_PLANS];

        if (!plan) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid plan in payment metadata",
          });
        }

        // Create or update subscription in database
        const company = await db.getCompanyById(ctx.user.companyId);
        if (!company) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Company not found",
          });
        }

        // Calculate subscription end date (30 days from now)
        const now = new Date();
        const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        // Check if subscription exists
        const existingSubscription = await db.getSubscriptionByCompanyId(ctx.user.companyId);

        if (existingSubscription) {
          // Update existing subscription
          await db.updateSubscription(
            existingSubscription.id,
            ctx.user.companyId,
            {
              plan: planType,
              status: "active",
              paystackAuthorizationCode: input.reference,
              startDate: now,
              endDate,
              renewalDate: endDate,
              amount: String(plan.monthlyAmount),
            }
          );
        } else {
          // Create new subscription
          await db.createSubscription({
            companyId: ctx.user.companyId,
            plan: planType,
            status: "active",
            paystackAuthorizationCode: input.reference,
            startDate: now,
            endDate,
            renewalDate: endDate,
            amount: String(plan.monthlyAmount),
            billingCycle: "monthly",
            currency: "USD",
          });
        }

        // Update company subscription status
        await db.updateCompany(ctx.user.companyId, {
          subscriptionStatus: "active",
          plan: planType,
        });

        return {
          success: true,
          message: "Payment verified and subscription activated",
          data: {
            reference: input.reference,
            planType,
            planName: plan.name,
            endDate,
          },
        };
      } catch (error: any) {
        console.error("[Payment] Paystack verification error:", error.response?.data || error.message);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.response?.data?.message || "Failed to verify payment",
        });
      }
    }),

  /**
   * Get payment plans
   * Public endpoint to get available plans
   */
  getPlans: protectedProcedure.query(async () => {
    return {
      plans: Object.entries(PAYMENT_PLANS).map(([key, value]) => ({
        id: key,
        ...value,
      })),
    };
  }),

  /**
   * Get company subscription
   * Get current subscription details
   */
  getSubscription: companyAdminProcedure.query(async ({ ctx }) => {
    if (!ctx.user.companyId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Company context required",
      });
    }

    const company = await db.getCompanyById(ctx.user.companyId);
    const subscription = await db.getSubscriptionByCompanyId(ctx.user.companyId);

    return {
      company: {
        id: company?.id,
        name: company?.name,
        subscriptionStatus: company?.subscriptionStatus,
        plan: company?.plan,
        trialEndsAt: company?.trialEndsAt,
      },
      subscription: subscription
        ? {
            id: subscription.id,
            plan: subscription.plan,
            status: subscription.status,
            amount: subscription.amount,
            startDate: subscription.startDate,
            endDate: subscription.endDate,
            renewalDate: subscription.renewalDate,
          }
        : null,
    };
  }),

  /**
   * Cancel subscription
   * Allows company admins to cancel their subscription
   */
  cancelSubscription: companyAdminProcedure.mutation(async ({ ctx }) => {
    if (!ctx.user.companyId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Company context required",
      });
    }

    const subscription = await db.getSubscriptionByCompanyId(ctx.user.companyId);

    if (!subscription) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "No active subscription found",
      });
    }

    await db.updateSubscription(subscription.id, ctx.user.companyId, {
      status: "inactive",
    });

    await db.updateCompany(ctx.user.companyId, {
      subscriptionStatus: "inactive",
    });

    return {
      success: true,
      message: "Subscription cancelled",
    };
  }),
});
