"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Float, Points } from "@react-three/drei";
import { useRef, useMemo } from "react";
import * as THREE from "three";

function NeuralSphere() {
  const group = useRef();

  const nodes = useMemo(() => {
    const pts = [];
    const radius = 2.2;

    for (let i = 0; i < 90; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      pts.push(
        new THREE.Vector3(
          radius * Math.sin(phi) * Math.cos(theta),
          radius * Math.sin(phi) * Math.sin(theta),
          radius * Math.cos(phi)
        )
      );
    }

    return pts;
  }, []);

  const lines = useMemo(() => {
    const segments = [];

    nodes.forEach((a, i) => {
      nodes.forEach((b, j) => {
        if (i !== j) {
          const dist = a.distanceTo(b);
          if (dist < 1.3) {
            segments.push(a.x, a.y, a.z);
            segments.push(b.x, b.y, b.z);
          }
        }
      });
    });

    return new Float32Array(segments);
  }, [nodes]);

  useFrame(() => {
    group.current.rotation.y += 0.002;
    group.current.rotation.x += 0.0005;
  });

  return (
    <group ref={group}>
      {/* Nodes */}
      {nodes.map((pos, i) => (
        <mesh key={i} position={pos}>
          <sphereGeometry args={[0.045, 16, 16]} />
          <meshBasicMaterial color="#2dd4bf" />
        </mesh>
      ))}

      {/* Connections */}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            array={lines}
            count={lines.length / 3}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial
          color="#14b8a6"
          transparent
          opacity={0.35}
        />
      </lineSegments>
    </group>
  );
}

function Particles() {
  const points = useMemo(() => {
    const p = [];
    for (let i = 0; i < 200; i++) {
      p.push(
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10
      );
    }
    return new Float32Array(p);
  }, []);

  return (
    <Points positions={points} stride={3}>
      <pointsMaterial
        color="#2dd4bf"
        size={0.02}
        sizeAttenuation
        transparent
        opacity={0.4}
      />
    </Points>
  );
}

export default function FinanceAIModel() {
  return (
    <Canvas camera={{ position: [0, 0, 6], fov: 50 }}>
      <ambientLight intensity={0.7} />
      <pointLight position={[3, 3, 3]} intensity={1.2} />

      <Float speed={2} rotationIntensity={0.4} floatIntensity={1}>
        <NeuralSphere />
      </Float>

      <Particles />

      <OrbitControls
        enableZoom={false}
        autoRotate
        autoRotateSpeed={0.5}
      />
    </Canvas>
  );
}