import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export const Test: React.FC = () => {
  const f = useCurrentFrame();
  const opacity = interpolate(f, [0, 15, 30], [0, 1, 1], {
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#111",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div style={{ color: "white", fontSize: 72, opacity }}>レンダリング確認 {f}</div>
    </AbsoluteFill>
  );
};
