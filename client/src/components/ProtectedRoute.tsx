import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";

interface ProtectedRouteProps {
  component: React.ComponentType<any>;
  requiredRoles?: ("super_admin" | "company_admin" | "staff")[];
  redirectTo?: string;
}

/**
 * ProtectedRoute Component
 * Enforces authentication and role-based access control
 */
export function ProtectedRoute({
  component: Component,
  requiredRoles = [],
  redirectTo = "/login",
}: ProtectedRouteProps) {
  const { user, loading, isAuthenticated } = useAuth({ redirectOnUnauthenticated: false });
  const [, setLocation] = useLocation();

  // Show loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  // Not authenticated
  if (!isAuthenticated || !user) {
    setLocation(redirectTo);
    return null;
  }

  // Check role-based access
  if (requiredRoles.length > 0 && !requiredRoles.includes(user.role)) {
    setLocation("/unauthorized");
    return null;
  }

  // Render component
  return <Component />;
}

export default ProtectedRoute;
