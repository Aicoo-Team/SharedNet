const PARTICLE_HOST_ID = "particles-js";

export default function ParticlesComponent() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden bg-gradient-to-tr from-[#e3f2fd] via-[#90caf9] to-[#64b5f6] dark:from-[#000814] dark:via-[#003566] dark:to-[#0077b6]"
      id={PARTICLE_HOST_ID}
    >
      <div
        className="absolute inset-0 opacity-45 dark:hidden"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgba(2, 119, 189, 0.66) 0 1px, transparent 1.6px), radial-gradient(circle, rgba(3, 155, 229, 0.32) 0 1px, transparent 1.6px)",
          backgroundPosition: "0 0, 18px 18px",
          backgroundSize: "36px 36px",
        }}
      />
      <div
        className="absolute inset-0 hidden opacity-55 dark:block"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgba(0, 245, 255, 0.66) 0 1px, transparent 1.6px), radial-gradient(circle, rgba(0, 150, 199, 0.36) 0 1px, transparent 1.6px)",
          backgroundPosition: "0 0, 18px 18px",
          backgroundSize: "36px 36px",
        }}
      />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(255,255,255,0.32),transparent_58%)] dark:bg-[radial-gradient(circle_at_50%_42%,rgba(0,217,255,0.12),transparent_62%)]" />
    </div>
  );
}
