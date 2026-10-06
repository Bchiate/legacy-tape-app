import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Mail, Lock, User, Eye, EyeOff, Loader2, Wrench } from "lucide-react";
import SkyBackground from "@/components/SkyBackground";
import { supabase } from "@/lib/supabase";

const Auth = () => {
  const navigate = useNavigate();
  const isAdmin = localStorage.getItem("adminMode") === "true";
  const [isLogin, setIsLogin] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({
          email: form.email,
          password: form.password,
        });
        if (error) throw error;
        navigate(window.__pendingPairingQR ? "/device-setup" : "/home");
      } else {
        const { error } = await supabase.auth.signUp({
          email: form.email,
          password: form.password,
          options: {
            data: { full_name: form.name },
          },
        });
        if (error) throw error;
        navigate(window.__pendingPairingQR ? "/device-setup" : "/home");
      }
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  // Testing Mode rides on a REAL account, never an anonymous one. Anonymous
  // sessions mint a brand-new user every time app storage is cleared, so a
  // device paired in one test cycle was owned by a user that no longer exists
  // by the next — every re-pair after a reinstall then failed with "paired to
  // another account". A real account (e.g. a dedicated tester@ login) keeps
  // ownership stable, so re-pairing and "Remove this device" always work.
  const handleAdminContinue = async () => {
    setError("");
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user.is_anonymous) {
        // Leftover from the old admin path — drop it rather than carry it forward.
        await supabase.auth.signOut();
      }
      if (!session || session.user.is_anonymous) {
        setError(
          "Testing Mode needs a real account so it can own the device across reinstalls. " +
          "Sign in above with your test account (create one with any email if you don't have one), then tap Continue."
        );
        return;
      }
      navigate(window.__pendingPairingQR ? "/device-setup" : "/home");
    } catch (err: any) {
      setError(err.message || "Could not continue");
    } finally {
      setLoading(false);
    }
  };

  const handleSocialLogin = async (provider: "google" | "apple") => {
    setError("");
    const isNative = !!(window as any).__nativeSpeechBridge;

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: isNative
          ? "fct.mylegacytape://callback"
          : window.location.origin,
        skipBrowserRedirect: isNative,
      },
    });

    if (error) {
      setError(error.message);
      return;
    }

    // In native app, Supabase returns the OAuth URL instead of redirecting.
    // Navigate to it so the WKNavigationDelegate can intercept and open ASWebAuthenticationSession.
    if (isNative && data?.url) {
      window.location.href = data.url;
    }
  };

  return (
    <div className="relative min-h-[100dvh] flex flex-col items-center justify-center px-6">
      <SkyBackground />

      <div className="w-full max-w-sm z-10">
        {/* Brand */}
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold tracking-tight text-foreground">
            LegacyTape
          </h1>
          <p className="text-muted-foreground text-sm mt-2">
            Stories worth keeping forever
          </p>
        </div>

        {/* Toggle */}
        <div className="flex rounded-xl bg-muted/60 backdrop-blur-sm p-1 mb-6">
          <button
            className={`flex-1 py-2.5 text-sm font-medium rounded-lg transition-all ${
              isLogin
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground"
            }`}
            onClick={() => { setIsLogin(true); setError(""); }}
          >
            Log In
          </button>
          <button
            className={`flex-1 py-2.5 text-sm font-medium rounded-lg transition-all ${
              !isLogin
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground"
            }`}
            onClick={() => { setIsLogin(false); setError(""); }}
          >
            Sign Up
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 rounded-xl bg-destructive/10 border border-destructive/30 text-destructive text-sm text-center">
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {!isLogin && (
            <div className="relative">
              <User className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Full name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full h-12 pl-11 pr-4 rounded-xl bg-card/80 backdrop-blur-sm border border-border/60 text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          )}

          <div className="relative">
            <Mail className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              type="email"
              placeholder="Email address"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="w-full h-12 pl-11 pr-4 rounded-xl bg-card/80 backdrop-blur-sm border border-border/60 text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="relative">
            <Lock className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              type={showPassword ? "text" : "password"}
              placeholder="Password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="w-full h-12 pl-11 pr-11 rounded-xl bg-card/80 backdrop-blur-sm border border-border/60 text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground"
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>

          {isLogin && (
            <button
              type="button"
              className="text-xs text-primary self-end -mt-1"
            >
              Forgot password?
            </button>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-semibold text-sm mt-2 active:opacity-80 transition-opacity shadow-sm flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {loading && <Loader2 className="size-4 animate-spin" />}
            {isLogin ? "Log In" : "Create Account"}
          </button>
        </form>

        {/* Divider */}
        <div className="flex items-center gap-3 my-6">
          <div className="flex-1 h-px bg-border/60" />
          <span className="text-xs text-muted-foreground">or continue with</span>
          <div className="flex-1 h-px bg-border/60" />
        </div>

        {/* Social buttons */}
        <div className="flex gap-3">
          <button
            onClick={() => handleSocialLogin("google")}
            className="flex-1 h-12 rounded-xl bg-card/80 backdrop-blur-sm border border-border/60 flex items-center justify-center gap-2 text-sm font-medium text-foreground active:opacity-80 transition-opacity"
          >
            <svg className="size-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Google
          </button>
          <button
            onClick={() => handleSocialLogin("apple")}
            className="flex-1 h-12 rounded-xl bg-card/80 backdrop-blur-sm border border-border/60 flex items-center justify-center gap-2 text-sm font-medium text-foreground active:opacity-80 transition-opacity"
          >
            <svg className="size-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
            </svg>
            Apple
          </button>
        </div>

        {/* Admin bypass */}
        {isAdmin && (
          <button
            onClick={handleAdminContinue}
            disabled={loading}
            className="w-full h-12 mt-4 rounded-xl border-2 border-dashed border-primary/40 text-primary font-semibold text-sm active:opacity-80 transition-opacity flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Wrench className="size-4" />}
            Continue in Testing Mode
          </button>
        )}
      </div>
    </div>
  );
};

export default Auth;
