import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, useMotionValue, useSpring, useTransform, MotionValue } from 'framer-motion';
import { Menu, Item, useContextMenu } from 'react-contexify';
import 'react-contexify/dist/ReactContexify.css';
import styles from './Dock.module.css';

interface DockItem {
  id: string;
  name: string;
  icon: React.ReactNode;
  isOpen?: boolean;
  onClick: () => void;
  onRemove?: () => void;
  onClose?: () => void;
}

interface DockProps {
  items: DockItem[];
  performanceMode?: boolean;
}

export const Dock: React.FC<DockProps> = ({ items, performanceMode = false }) => {
  const mouseX = useMotionValue<number>(Infinity);

  return (
    <div className={styles.dockContainer}>
      {performanceMode ? (
        <div className={`${styles.dock} ${styles.performanceMode}`}>
          {items.map((item) => (
            <DockIcon key={item.id} mouseX={mouseX} item={item} performanceMode={true} />
          ))}
        </div>
      ) : (
        <motion.div
          className={styles.dock}
          onMouseMove={(e) => mouseX.set(e.pageX)}
          onMouseLeave={() => mouseX.set(Infinity)}
        >
          {items.map((item) => (
            <DockIcon key={item.id} mouseX={mouseX} item={item} performanceMode={false} />
          ))}
        </motion.div>
      )}
    </div>
  );
};

function DockIcon({ mouseX, item, performanceMode }: { mouseX: MotionValue<number>; item: DockItem; performanceMode: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { show } = useContextMenu({ id: `dock-menu-${item.id}` });

  const distance = useTransform(mouseX, (val) => {
    const bounds = ref.current?.getBoundingClientRect() ?? { x: 0, width: 0 };
    return val - bounds.x - bounds.width / 2;
  });

  const widthSync = useTransform(distance, [-150, 0, 150], [50, 100, 50]);
  const width = useSpring(widthSync, { mass: 0.1, stiffness: 150, damping: 12 });

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    show({ event: e });
  };

  return (
    <>
      {performanceMode ? (
        <div
          ref={ref}
          style={{ width: 50 }}
          className={`${styles.dockItem} ${styles.performanceItem}`}
          onClick={item.onClick}
          onContextMenu={handleContextMenu}
        >
          <div className={styles.tooltip}>{item.name}</div>
          <div className={styles.iconWrapper} style={{ width: 50, height: 50 }}>
            <div className={styles.iconContent} style={{ fontSize: '2.5em' }}>
              {item.icon}
            </div>
          </div>
          {item.isOpen && <div className={styles.dot} />}
        </div>
      ) : (
        <motion.div
          ref={ref}
          style={{ width }}
          className={styles.dockItem}
          onClick={item.onClick}
          onContextMenu={handleContextMenu}
        >
          <div className={styles.tooltip}>{item.name}</div>
          <motion.div className={styles.iconWrapper} style={{ width, height: width }}>
            <div className={styles.iconContent} style={{ fontSize: '2.5em' }}>
              {item.icon}
            </div>
          </motion.div>
          {item.isOpen && <div className={styles.dot} />}
        </motion.div>
      )}

      {createPortal(
        <Menu id={`dock-menu-${item.id}`} theme="light" animation="scale">
          <Item onClick={item.onClick}>打开</Item>
          {item.onClose && <Item onClick={item.onClose}>退出</Item>}
          {item.onRemove && <Item onClick={item.onRemove}>从 Dock 中移除</Item>}
          <Item disabled>选项...</Item>
        </Menu>,
        document.body
      )}
    </>
  );
}