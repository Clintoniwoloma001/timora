import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { isSubscriptionActive } from "../db";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

// ============================================================================
// MIDDLEWARE: Require User
// ============================================================================

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

// ============================================================================
// MIDDLEWARE: Require Company Admin
// ============================================================================

const requireCompanyAdmin = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  if (ctx.user.role !== 'company_admin' && ctx.user.role !== 'super_admin') {
    throw new TRPCError({ 
      code: "FORBIDDEN", 
      message: "Only company admins can perform this action" 
    });
  }

  if (!ctx.user.companyId && ctx.user.role !== 'super_admin') {
    throw new TRPCError({ 
      code: "FORBIDDEN", 
      message: "Company context required" 
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const companyAdminProcedure = t.procedure.use(requireCompanyAdmin);

// ============================================================================
// MIDDLEWARE: Require Super Admin
// ============================================================================

const requireSuperAdmin = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user || ctx.user.role !== 'super_admin') {
    throw new TRPCError({ code: "FORBIDDEN", message: "Super admin access required" });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const superAdminProcedure = t.procedure.use(requireSuperAdmin);

// ============================================================================
// MIDDLEWARE: Require Active Subscription (ROLE-AWARE FIX) - CRITICAL
// ============================================================================
/**
 * CRITICAL FIX: Role-aware subscription middleware
 * 
 * PROBLEM: Subscription check was applied globally to ALL users
 * SOLUTION: Check role first, then only enforce for company_admin
 * 
 * Rules:
 * - super_admin: ALWAYS bypass subscription check (system-wide access)
 * - staff: ALWAYS bypass subscription check (uses company's subscription)
 * - company_admin: MUST have active company subscription (tied to COMPANY, not user)
 * 
 * Subscription is COMPANY-LEVEL, not user-level
 */
const requireActiveSubscription = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  // CRITICAL FIX #1: Super admins ALWAYS bypass subscription check
  if (ctx.user.role === 'super_admin') {
    console.log(`[Subscription] ✅ SUPER_ADMIN "${ctx.user.name}" - FULL ACCESS (bypassing subscription check)`);
    return next({ ctx });
  }

  // CRITICAL FIX #2: Staff ALWAYS bypass subscription check (covered by company subscription)
  if (ctx.user.role === 'staff') {
    console.log(`[Subscription] ✅ STAFF "${ctx.user.name}" - ACCESS ALLOWED (company subscription applies)`);
    return next({ ctx });
  }

  // CRITICAL FIX #3: Company admins MUST have active company subscription
  if (ctx.user.role === 'company_admin') {
    if (!ctx.user.companyId) {
      console.error(`[Subscription] ❌ COMPANY_ADMIN "${ctx.user.name}" - NO COMPANY CONTEXT`);
      throw new TRPCError({ 
        code: "FORBIDDEN", 
        message: "Company context required" 
      });
    }

    const subscriptionActive = await isSubscriptionActive(ctx.user.companyId);
    
    if (!subscriptionActive) {
      console.warn(`[Subscription] ⚠️ COMPANY_ADMIN "${ctx.user.name}" (company: ${ctx.user.companyId}) - SUBSCRIPTION INACTIVE`);
      throw new TRPCError({ 
        code: "PAYMENT_REQUIRED", 
        message: "Your company subscription has expired. Please renew to continue." 
      });
    }

    console.log(`[Subscription] ✅ COMPANY_ADMIN "${ctx.user.name}" (company: ${ctx.user.companyId}) - SUBSCRIPTION ACTIVE`);
    return next({ ctx });
  }

  // Default: allow access (for any other roles)
  console.log(`[Subscription] ✅ User "${ctx.user.name}" (role: ${ctx.user.role}) - ACCESS ALLOWED`);
  return next({ ctx });
});

export const protectedWithSubscriptionProcedure = t.procedure
  .use(requireUser)
  .use(requireActiveSubscription);

// ============================================================================
// MIDDLEWARE: Legacy Admin Check (for backward compatibility)
// ============================================================================

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || (ctx.user.role !== 'company_admin' && ctx.user.role !== 'super_admin')) {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
